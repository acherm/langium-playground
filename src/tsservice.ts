// A TypeScript language service for the validator and the generator: completion, types on hover,
// type errors, go to definition, rename. No DOM, no worker API: this module runs the same way in
// Node (test/tsservice.test.ts) and in a web worker (src/tsworker.ts).
//
// The two files are checked inside a small virtual project laid out as the Langium template:
//
//   /src/language/validator.ts        the Validator tab
//   /src/language/module.ts           written here: the XServices type, with the validator classes
//   /src/language/generated/ast.ts    produced by Langium from the grammar (the "AST types" tab)
//   /src/cli/generator.ts             the Generator tab
//   /src/cli/cli-util.ts              written here: extractDestinationAndName
//   /node_modules/langium/...         the real declarations of Langium and of what it refers to
//
// This service only informs: the code is run by src/usercode.ts whatever it says.
import ts from 'typescript5';

export type CodeFile = 'validator' | 'generator';
/** The texts the service works on. `name` is the name of the grammar (HelloWorld). */
export interface Sources { validator: string; generator: string; ast: string; name: string }

export interface TsProblem { from: number; to: number; line: number; col: number; severity: 'error' | 'warning' | 'info'; message: string }
export interface TsCompletion { label: string; kind: string; detail?: string }
export interface TsCompletions { from: number; items: TsCompletion[] }
export interface TsLocation { file: CodeFile | 'ast'; from: number; to: number }
export interface TsRename { name: string; spans: { from: number; to: number }[] }

const PATHS = {
    validator: '/src/language/validator.ts',
    module: '/src/language/module.ts',
    ast: '/src/language/generated/ast.ts',
    generator: '/src/cli/generator.ts',
    util: '/src/cli/cli-util.ts',
    env: '/src/playground-env.d.ts',
} as const;

/** What exists in the page besides the language: a console, and stand-ins for node:fs and node:path. */
const ENVIRONMENT = `
declare const console: {
    log(...data: any[]): void; info(...data: any[]): void; warn(...data: any[]): void;
    error(...data: any[]): void; debug(...data: any[]): void; trace(...data: any[]): void;
};
declare module 'node:fs' {
    /** In the playground, the file is not written to a disk: it is shown in "Output". */
    export function writeFileSync(path: string, data: string): void;
    export function appendFileSync(path: string, data: string): void;
    export function existsSync(path: string): boolean;
    export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
    /** In the playground, only a file written by the generator can be read. */
    export function readFileSync(path: string, encoding?: string): string;
    const fs: { writeFileSync: typeof writeFileSync; appendFileSync: typeof appendFileSync; existsSync: typeof existsSync; mkdirSync: typeof mkdirSync; readFileSync: typeof readFileSync };
    export default fs;
}
declare module 'fs' { export * from 'node:fs'; export { default } from 'node:fs'; }
declare module 'node:path' {
    export function join(...paths: string[]): string;
    export function resolve(...paths: string[]): string;
    export function basename(path: string, suffix?: string): string;
    export function extname(path: string): string;
    export function dirname(path: string): string;
    export function parse(path: string): { dir: string; base: string; ext: string; name: string };
    export const sep: string;
    const path: { join: typeof join; resolve: typeof resolve; basename: typeof basename; extname: typeof extname; dirname: typeof dirname; parse: typeof parse; sep: string };
    export default path;
}
declare module 'path' { export * from 'node:path'; export { default } from 'node:path'; }
`;

const CLI_UTIL = `export interface FilePathData { destination: string; name: string }
/** As in the Langium project template: where to write, and the name of the program without its extension. */
export declare function extractDestinationAndName(filePath: string, destination: string | undefined): FilePathData;
`;

/** The module of a Langium project declares the services of the language: here, the validator classes. */
function moduleSource(sources: Sources): string {
    const classes = [...sources.validator.matchAll(/^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
    const name = sources.name || 'My';
    return `import type { LangiumServices } from 'langium/lsp';
${classes.length ? `import type { ${classes.join(', ')} } from './validator.js';\n` : ''}
/** The services that this language adds to the default ones of Langium. */
export type ${name}AddedServices = {
    validation: {
${classes.map(c => `        ${c}: ${c}`).join(',\n')}
    }
};
/** All the services of the language: what \`registerValidationChecks\` receives. */
export type ${name}Services = LangiumServices & ${name}AddedServices;
`;
}

const KINDS: Record<string, string> = {
    method: 'method', function: 'function', 'local function': 'function', constructor: 'function',
    property: 'property', getter: 'property', setter: 'property', 'JSX attribute': 'property',
    class: 'class', 'local class': 'class', interface: 'interface', type: 'type', 'type parameter': 'type', alias: 'type', enum: 'enum', 'enum member': 'constant',
    var: 'variable', 'local var': 'variable', let: 'variable', const: 'constant', parameter: 'variable',
    keyword: 'keyword', module: 'namespace', 'external module name': 'namespace', string: 'text',
};

export function createService(libs: Record<string, string>) {
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ['lib.es2022.d.ts'], types: [], strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
    };
    const project = new Map<string, { text: string; version: number }>();
    const set = (path: string, text: string) => {
        const known = project.get(path);
        if (!known) project.set(path, { text, version: 1 });
        else if (known.text !== text) { known.text = text; known.version++; }
    };
    const read = (path: string): string | undefined => project.get(path)?.text ?? libs[path];
    const directories = new Set<string>();
    for (const file of [...Object.keys(libs), ...Object.values(PATHS)]) {
        for (let dir = file; (dir = dir.slice(0, dir.lastIndexOf('/'))) !== '';) directories.add(dir);
    }

    /** The same shortcuts as when the code runs (src/usercode.ts): these files are where the template puts them. */
    function special(specifier: string): string | undefined {
        if (/(^|\/)ast(\.js|\.ts)?$/.test(specifier)) return PATHS.ast;
        if (/module(\.js|\.ts)?$/.test(specifier) && specifier.startsWith('.')) return PATHS.module;
        if (/(^|\/)(cli-)?util(\.js|\.ts)?$/.test(specifier)) return PATHS.util;
        return undefined;
    }

    const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => options,
        getScriptFileNames: () => [PATHS.validator, PATHS.generator, PATHS.env],
        getScriptVersion: path => String(project.get(path)?.version ?? 0),
        getScriptSnapshot: path => { const text = read(path); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
        getCurrentDirectory: () => '/',
        getDefaultLibFileName: () => '/lib/lib.es2022.d.ts',
        fileExists: path => read(path) !== undefined,
        readFile: path => read(path),
        directoryExists: path => directories.has(path.replace(/\/$/, '')) || path === '/',
        getDirectories: () => [],
        useCaseSensitiveFileNames: () => true,
        resolveModuleNameLiterals: (literals, containingFile) => literals.map(literal => {
            const direct = containingFile.startsWith('/src/') ? special(literal.text) : undefined;
            if (direct) return { resolvedModule: { resolvedFileName: direct, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
            return { resolvedModule: ts.resolveModuleName(literal.text, containingFile, options, host).resolvedModule };
        }),
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    set(PATHS.env, ENVIRONMENT);
    set(PATHS.util, CLI_UTIL);

    function update(sources: Sources) {
        set(PATHS.validator, sources.validator);
        set(PATHS.generator, sources.generator);
        set(PATHS.ast, sources.ast || "import * as langium from 'langium';\n");
        set(PATHS.module, moduleSource(sources));
    }
    update({ validator: '', generator: '', ast: '', name: '' });

    const fileOf = (path: string): TsLocation['file'] | undefined =>
        path === PATHS.validator ? 'validator' : path === PATHS.generator ? 'generator' : path === PATHS.ast ? 'ast' : undefined;

    return {
        update,

        diagnostics(file: CodeFile): TsProblem[] {
            const path = PATHS[file], text = read(path) ?? '';
            if (!text.trim()) return [];
            const source = service.getProgram()?.getSourceFile(path);
            return [...service.getSyntacticDiagnostics(path), ...service.getSemanticDiagnostics(path)].map(d => {
                const from = d.start ?? 0;
                const at = source ? source.getLineAndCharacterOfPosition(from) : { line: 0, character: 0 };
                return {
                    from, to: from + (d.length ?? 0), line: at.line + 1, col: at.character + 1,
                    severity: d.category === ts.DiagnosticCategory.Error ? 'error' as const : d.category === ts.DiagnosticCategory.Warning ? 'warning' as const : 'info' as const,
                    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
                };
            });
        },

        complete(file: CodeFile, offset: number): TsCompletions {
            const path = PATHS[file], text = read(path) ?? '';
            const info = service.getCompletionsAtPosition(path, offset, { includeCompletionsForModuleExports: false, includeCompletionsWithInsertText: false });
            let from = offset;
            while (from > 0 && /[\w$]/.test(text[from - 1])) from--;
            if (info?.optionalReplacementSpan) from = info.optionalReplacementSpan.start;
            const items = (info?.entries ?? [])
                .sort((a, b) => a.sortText.localeCompare(b.sortText) || a.name.localeCompare(b.name))
                .slice(0, 400)
                .map(e => ({ label: e.name, kind: KINDS[e.kind] ?? 'text', detail: e.kind === 'keyword' ? undefined : e.kind }));
            return { from, items };
        },

        /** The declaration of what is under `offset`, with its documentation. */
        hover(file: CodeFile, offset: number): string {
            const info = service.getQuickInfoAtPosition(PATHS[file], offset);
            if (!info) return '';
            const doc = ts.displayPartsToString(info.documentation);
            return ts.displayPartsToString(info.displayParts) + (doc ? `\n\n${doc}` : '');
        },

        /** Where what is under `offset` is declared, if it is in one of the files shown in the page. */
        definition(file: CodeFile, offset: number): TsLocation | null {
            for (const d of service.getDefinitionAtPosition(PATHS[file], offset) ?? []) {
                const target = fileOf(d.fileName);
                if (target) return { file: target, from: d.textSpan.start, to: d.textSpan.start + d.textSpan.length };
            }
            return null;
        },

        /** Every place in this file that a rename at `offset` would change. */
        rename(file: CodeFile, offset: number): TsRename | null {
            const path = PATHS[file];
            const info = service.getRenameInfo(path, offset, {});
            if (!info.canRename) return null;
            const spans = (service.findRenameLocations(path, offset, false, false, {}) ?? [])
                .filter(l => l.fileName === path)
                .map(l => ({ from: l.textSpan.start, to: l.textSpan.start + l.textSpan.length }));
            return spans.length ? { name: info.displayName, spans } : null;
        },
    };
}
