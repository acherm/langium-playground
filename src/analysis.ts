// The Langium side of the playground. No DOM, no worker API: this module runs the same way in
// Node (see test/analysis.test.mjs) and in the web worker (src/worker.ts).
//
// The grammar is interpreted by `createServicesForGrammar`: no generated code, and no validation
// other than what Langium does by default (lexing, parsing, linking).
import { EmptyFileSystem, GrammarAST, URI, type LangiumDocument } from 'langium';
import { createLangiumGrammarServices, createServicesForGrammar } from 'langium/grammar';
import { exportedClasses, generatorFunction, load, locate as locateInCode, newOutput, runGenerator, type Environment, type Output } from './usercode.ts';

export type { Output } from './usercode.ts';

export type Severity = 'error' | 'warning' | 'info';
export interface Problem {
    from: number;       // offsets in the analysed text
    to: number;
    line: number;       // 1-based
    col: number;        // 1-based
    severity: Severity;
    source: string;     // lexer, parser, linker, validation, grammar, chevrotain
    message: string;
}
export interface GrammarResult {
    ok: boolean;        // true when programs can be analysed: parser built, validator loaded
    name: string;
    entry: string;      // name of the entry rule
    rules: number;
    problems: Problem[];
    /** Problems in the user's validator and generator code (positions are in that code). */
    validator: Problem[];
    generator: Problem[];
}
/** The TypeScript written next to the grammar. An empty text means: none. */
export interface UserCode { validator?: string; generator?: string }
/** [offset, length, class, token type name] */
export type Token = [number, number, string, string];
export interface ProgramResult {
    problems: Problem[];
    /** JSON of the AST, with `$textRegion` on every node. */
    ast: string;
    tokens: Token[];
    /** What the parser reported about the grammar while analysing this program (ambiguities). */
    grammarWarnings: Problem[];
    /** none: no generator. skipped: the program has errors. failed: the generator threw. */
    generated: 'none' | 'skipped' | 'ok' | 'failed';
    output?: Output;
    /** Where the generator failed on this program (positions are in the generator code). */
    generatorProblems: Problem[];
}
export interface Completion {
    label: string;
    detail?: string;
    kind: 'keyword' | 'reference' | 'other';
    from: number;
    to: number;
    insert: string;
}

type Services = Awaited<ReturnType<typeof createServicesForGrammar>>;

const grammarServices = createLangiumGrammarServices(EmptyFileSystem).grammar;
let current: {
    text: string; grammar: GrammarAST.Grammar; services: Services; terminals: Set<string>; ext: string;
    env: Environment;
    generator?: { run: (...args: any[]) => unknown; code: string };
} | undefined;
let counter = 0;

const SOURCES: Record<string, string> = {
    'lexing-error': 'lexer',
    'parsing-error': 'parser',
    'linking-error': 'linker',
};

function problemsOf(doc: LangiumDocument, fallbackSource: string): Problem[] {
    const td = doc.textDocument;
    return (doc.diagnostics ?? [])
        .map(d => {
            const code = (d.data as { code?: string } | undefined)?.code ?? '';
            const from = td.offsetAt(d.range.start);
            return {
                from,
                to: Math.max(from, td.offsetAt(d.range.end)),
                line: d.range.start.line + 1,
                col: d.range.start.character + 1,
                severity: (d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info') as Severity,
                source: SOURCES[code] ?? fallbackSource,
                message: typeof d.message === 'string' ? d.message : d.message.value,
            };
        })
        .sort((a, b) => a.from - b.from);
}

/** Runs `fn` and returns what was printed on the console meanwhile (Chevrotain reports there). */
async function capturing<T>(fn: () => T | Promise<T>): Promise<{ value?: T; error?: unknown; printed: string[] }> {
    const printed: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const grab = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    console.log = grab; console.warn = grab; console.error = grab;
    try {
        return { value: await fn(), printed };
    } catch (error) {
        return { error, printed };
    } finally {
        console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
    }
}

/** Finds where a Chevrotain message talks about: it names rules as <Rule> or 'Rule'. */
function locate(text: string, grammar: GrammarAST.Grammar, message: string): { from: number; to: number } {
    const names = [...message.matchAll(/<(\w+)>|'(\w+)'|rule:? ->?(\w+)<?-?/g)].map(m => m[1] ?? m[2] ?? m[3]);
    for (const name of names) {
        const rule = grammar.rules.find(r => r.name === name);
        const cst = rule?.$cstNode;
        if (cst) {
            const at = text.indexOf(name, cst.offset);
            const from = at >= 0 && at < cst.end ? at : cst.offset;
            return { from, to: from + name.length };
        }
    }
    const nl = text.indexOf('\n');
    return { from: 0, to: nl < 0 ? text.length : nl };
}

/** Chevrotain packs its findings in one message, separated by dashed lines, and pads rule names with U+200B. */
function split(message: string): string[] {
    const parts = message.replace(/\u200B/g, '').split(/\n-{5,}\n?/)
        .map(s => s.replace(/^\s*(Parser Definition Errors detected:|Errors detected in definition of Lexer:)\s*/i, '').trim())
        .filter(Boolean);
    return parts.length ? parts : [message];
}

function positioned(text: string, range: { from: number; to: number }, severity: Severity, source: string, message: string): Problem {
    const before = text.slice(0, range.from);
    const line = before.split('\n').length;
    return { ...range, line, col: range.from - before.lastIndexOf('\n'), severity, source, message };
}

/** A problem in user code, from the line and column where it was found. */
function inCode(code: string, error: unknown, file: string, source: string, severity: Severity = 'error'): Problem {
    const at = locateInCode(error, file, code);
    const lines = code.split('\n');
    const from = lines.slice(0, at.line - 1).reduce((n, l) => n + l.length + 1, 0) + Math.min(at.col - 1, lines[at.line - 1]?.length ?? 0);
    const to = lines.slice(0, at.line).reduce((n, l) => n + l.length + 1, 0) - 1;
    return { from, to: Math.max(from, to), line: at.line, col: at.col, severity, source, message: at.message };
}

export async function analyzeGrammar(text: string, code: UserCode = {}): Promise<GrammarResult> {
    forget('program');
    current = undefined;
    const { doc } = await documentOf('grammar', text);
    const grammar = doc.parseResult.value as GrammarAST.Grammar;
    const problems = problemsOf(doc, 'grammar');
    const entry = grammar.rules?.find(r => GrammarAST.isParserRule(r) && r.entry)?.name ?? '';
    const result: GrammarResult = { ok: false, name: grammar.name ?? '', entry, rules: grammar.rules?.length ?? 0, problems, validator: [], generator: [] };
    if (problems.some(p => p.severity === 'error')) return result;

    // The validator file is evaluated first: the classes it exports become services of the language
    // (`services.validation.XValidator`), exactly as the module of a Langium project declares them.
    const env: Environment = { output: newOutput() };
    const validatorCode = code.validator?.trim() ? code.validator : '';
    let validator: Record<string, any> | undefined;
    if (validatorCode) {
        try { validator = load(validatorCode, 'validator.ts', env).exports; }
        catch (e) { result.validator.push(inCode(validatorCode, e, 'validator.ts', 'validator')); }
    }
    const module = { validation: Object.fromEntries(exportedClasses(validator ?? {}).map(([name, Class]) => [name, (services: unknown) => new Class(services)])) };

    // Build the lexer and the parser now: this is where Chevrotain rejects a grammar.
    const built = await capturing(async () => {
        const services = await createServicesForGrammar({ grammar: text, module: module as any });
        void services.parser.Lexer;
        void services.parser.LangiumParser;
        services.parser.LangiumParser.parse('');
        return services;
    });
    for (const message of built.printed) {
        for (const part of split(message)) problems.push(positioned(text, locate(text, grammar, part), 'warning', 'chevrotain', part));
    }
    if (built.error || !built.value) {
        const message = built.error instanceof Error ? built.error.message : String(built.error);
        for (const part of split(message)) problems.push(positioned(text, locate(text, grammar, part), 'error', 'chevrotain', part));
        return result;
    }
    const services = built.value;
    env.reflection = services.shared.AstReflection;

    if (validator) {
        if (typeof validator.registerValidationChecks !== 'function') {
            result.validator.push(inCode(validatorCode, 'This file exports no function `registerValidationChecks(services)`: nothing is checked.', 'validator.ts', 'validator', 'warning'));
        } else {
            try { validator.registerValidationChecks(services); }
            catch (e) { result.validator.push(inCode(validatorCode, e, 'validator.ts', 'validator')); }
        }
    }
    // A validator that does not load would let programs pass that it should reject: nothing is analysed.
    if (result.validator.some(p => p.severity === 'error')) return result;

    let generator: { run: (...args: any[]) => unknown; code: string } | undefined = undefined;
    const generatorCode = code.generator?.trim() ? code.generator : '';
    if (generatorCode) {
        try {
            const run = generatorFunction(load(generatorCode, 'generator.ts', env).exports);
            if (run) generator = { run, code: generatorCode };
            else result.generator.push(inCode(generatorCode, 'No generator function found. Export one function, or name it generate... (also accepted: compile..., transform..., interpret..., run..., toSomething, or a default export). It receives the root of the AST.', 'generator.ts', 'generator'));
        } catch (e) { result.generator.push(inCode(generatorCode, e, 'generator.ts', 'generator')); }
    }

    const terminals = new Set(grammar.rules.filter(GrammarAST.isTerminalRule).map(r => r.name));
    current = { text, grammar, services, terminals, ext: services.LanguageMetaData.fileExtensions[0] ?? '.txt', env, generator };
    result.ok = true;
    return result;
}

// ---- documents
// At most one document is alive per side (the grammar, the program), the last text that was sent.
// It stays in Langium's workspace until another text arrives, so that the editor features
// (definition, rename...) find it; it is removed then, so that programs never see each other.

export type Target = 'grammar' | 'program';
type AnyServices = Services | typeof grammarServices;
interface Live { text: string; doc: LangiumDocument; services: AnyServices }
const live: Partial<Record<Target, Live>> = {};

function forget(target: Target) {
    const l = live[target];
    if (!l) return;
    delete live[target];
    l.services.shared.workspace.LangiumDocuments.deleteDocument(l.doc.uri);
    l.services.shared.workspace.IndexManager.remove(l.doc.uri);
}

async function documentOf(target: Target, text: string): Promise<Live> {
    const services: AnyServices | undefined = target === 'grammar' ? grammarServices : current?.services;
    if (!services) throw new Error('No valid grammar.');
    const known = live[target];
    if (known && known.text === text && known.services === services) return known;
    forget(target);
    const ext = target === 'grammar' ? '.langium' : current!.ext;
    const uri = URI.parse(`memory:/${target}-${counter++}${ext}`);
    const workspace = services.shared.workspace;
    const doc = workspace.LangiumDocumentFactory.fromString(text, uri);
    workspace.LangiumDocuments.addDocument(doc);
    try {
        await workspace.DocumentBuilder.build([doc], { validation: true });
    } catch (error) {
        workspace.LangiumDocuments.deleteDocument(uri);
        workspace.IndexManager.remove(uri);
        throw error;
    }
    return live[target] = { text, doc, services };
}

function classify(type: string, image: string, terminals: Set<string>, hidden: boolean): string {
    if (hidden) return /^\s*$/.test(image) ? '' : 'comment';
    if (!terminals.has(type)) return /^\w/.test(image) ? 'keyword' : 'punct';
    if (/^["'`]/.test(image)) return 'string';
    if (/^[-+]?\.?\d/.test(image)) return 'number';
    return 'terminal';
}

export async function analyzeProgram(text: string, name = 'program'): Promise<ProgramResult> {
    if (!current) throw new Error('No valid grammar.');
    const { terminals, services, generator, env } = current;
    const run = await capturing(async () => {
        const { doc } = await documentOf('program', text);
        const lexed = services.parser.Lexer.tokenize(text);
        const tokens: Token[] = [];
        for (const [list, hidden] of [[lexed.tokens, false], [lexed.hidden, true]] as const) {
            for (const t of list) {
                const cls = classify(t.tokenType.name, t.image, terminals, hidden);
                if (cls) tokens.push([t.startOffset, t.image.length, cls, t.tokenType.name]);
            }
        }
        tokens.sort((a, b) => a[0] - b[0]);
        const ast = services.serializer.JsonSerializer.serialize(doc.parseResult.value, { textRegions: true, refText: true });
        const problems = problemsOf(doc, 'validation');

        // The generator runs on a valid program only, as the command line of a Langium project does.
        let generated: ProgramResult['generated'] = 'none', output: Output | undefined;
        const generatorProblems: Problem[] = [];
        if (generator) {
            if (problems.some(p => p.severity === 'error')) generated = 'skipped';
            else {
                try { output = await runGenerator(generator.run, doc.parseResult.value, name, env); generated = 'ok'; }
                catch (e) {
                    generated = 'failed';
                    output = env.output;          // what was printed and written before the failure
                    generatorProblems.push(inCode(generator.code, e, 'generator.ts', 'generator'));
                }
            }
        }
        return { problems, ast, tokens, generated, output, generatorProblems };
    });
    if (run.error || !run.value) throw run.error ?? new Error('Analysis failed.');
    const { text: grammarText, grammar } = current!;
    const grammarWarnings = [...new Set(run.printed.flatMap(split))]
        .map(m => positioned(grammarText, locate(grammarText, grammar, m), 'warning', 'chevrotain', m));
    return { ...run.value, grammarWarnings };
}

// ---- editor features
// Langium's providers (the ones a language server would expose) are called directly. They speak in
// LSP types (positions as line and character): everything is converted to offsets here.

export interface Span { from: number; to: number }
export interface Edit extends Span { insert: string }

/** Runs `fn` on the document of `text`; any failure gives `fallback` (a feature must never break the page). */
async function feature<T>(target: Target, text: string, offset: number, fallback: T,
    fn: (ctx: { doc: LangiumDocument; lsp: NonNullable<AnyServices['lsp']>; at: { textDocument: { uri: string }; position: { line: number; character: number } }; span: (r: { start: any; end: any }) => Span }) => Promise<T>): Promise<T> {
    const run = await capturing(async () => {
        const { doc, services } = await documentOf(target, text);
        const td = doc.textDocument;
        return fn({
            doc, lsp: services.lsp,
            at: { textDocument: { uri: td.uri }, position: td.positionAt(offset) },
            span: r => ({ from: td.offsetAt(r.start), to: td.offsetAt(r.end) }),
        });
    });
    return run.value ?? fallback;
}

/** Where the name under `offset` is declared. */
export function definition(target: Target, text: string, offset: number): Promise<Span | null> {
    return feature(target, text, offset, null, async ({ doc, lsp, at, span }) => {
        const links = await lsp.DefinitionProvider?.getDefinition(doc, at);
        const link = links?.find(l => l.targetUri === doc.textDocument.uri);
        return link ? span(link.targetSelectionRange) : null;
    });
}

/** The declaration of the name under `offset` and all its uses. */
export function occurrences(target: Target, text: string, offset: number): Promise<Span[]> {
    return feature(target, text, offset, [], async ({ doc, lsp, at, span }) =>
        ((await lsp.DocumentHighlightProvider?.getDocumentHighlight(doc, at)) ?? []).map(h => span(h.range)));
}

/** Documentation of the element under `offset` (its comment), as Markdown. */
export function hover(target: Target, text: string, offset: number): Promise<string> {
    return feature(target, text, offset, '', async ({ doc, lsp, at }) => {
        const contents = (await lsp.HoverProvider?.getHoverContent(doc, at))?.contents;
        return typeof contents === 'string' ? contents : contents && 'value' in contents ? contents.value : '';
    });
}

/** The name that a rename at `offset` would change, or null if there is nothing to rename there. */
export function renameTarget(target: Target, text: string, offset: number): Promise<(Span & { name: string }) | null> {
    return feature(target, text, offset, null, async ({ doc, lsp, at, span }) => {
        const range = await lsp.RenameProvider?.prepareRename(doc, at);
        if (!range) return null;
        const s = span(range);
        return { ...s, name: text.slice(s.from, s.to) };
    });
}

/** The edits that rename the element under `offset`, declaration and uses. */
export function rename(target: Target, text: string, offset: number, name: string): Promise<Edit[]> {
    return feature(target, text, offset, [], async ({ doc, lsp, at, span }) => {
        const edit = await lsp.RenameProvider?.rename(doc, { ...at, newName: name });
        return (edit?.changes?.[doc.textDocument.uri] ?? []).map(e => ({ ...span(e.range), insert: e.newText }));
    });
}

/** The edits that format the whole text (Langium has a formatter for grammars, none for a new language). */
export function format(target: Target, text: string): Promise<Edit[]> {
    return feature(target, text, 0, [], async ({ doc, lsp, at, span }) => {
        if (doc.parseResult.lexerErrors.length || doc.parseResult.parserErrors.length) return [];
        const edits = await lsp.Formatter?.formatDocument(doc, { textDocument: at.textDocument, options: { tabSize: 4, insertSpaces: true } });
        return (edits ?? []).map(e => ({ ...span(e.range), insert: e.newText }));
    });
}

export function complete(target: Target, text: string, offset: number): Promise<Completion[]> {
    return feature(target, text, offset, [], async ({ doc, lsp }) => {
        const provider = lsp.CompletionProvider;
        if (!provider) return [];
        const position = doc.textDocument.positionAt(offset);
        const list = await provider.getCompletion(doc, { textDocument: { uri: doc.textDocument.uri }, position });
        return (list?.items ?? []).map((item): Completion => {
            const edit = item.textEdit && 'range' in item.textEdit ? item.textEdit : undefined;
            return {
                label: item.label,
                detail: item.detail,
                kind: item.kind === 14 ? 'keyword' : item.kind === 18 ? 'reference' : 'other',
                from: edit ? doc.textDocument.offsetAt(edit.range.start) : offset,
                to: edit ? doc.textDocument.offsetAt(edit.range.end) : offset,
                insert: edit?.newText ?? item.insertText ?? item.label,
            };
        });
    });
}
