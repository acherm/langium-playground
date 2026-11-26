// Runs the TypeScript that the user writes next to the grammar: a validator and a generator.
//
// The code is written as in a Langium project (same imports, same interfaces). Three differences:
//   - types are erased, not checked (Sucrase removes them; there is no TypeScript compiler here);
//   - the modules it may import are provided below, not read from disk;
//   - `./generated/ast.js` is not generated: its `isX` functions and `X` constants are answered
//     from the grammar that is being interpreted.
import * as langiumApi from 'langium';
import * as generateApi from 'langium/generate';
import * as lspApi from 'langium/lsp';
import { transform } from 'sucrase';

export interface CodeProblem { line: number; col: number; message: string }

export interface OutputFile { path: string; content: string }
export interface Output {
    files: OutputFile[];
    /** What the generator returned, if it is not the path of a file it wrote. */
    result?: string;
    console: string[];
}

interface Reflection { getAllTypes(): string[]; isInstance(node: unknown, type: string): boolean; getTypeMetaData(type: string): { properties: Record<string, unknown> } }

/** What a piece of user code can reach; filled in as the language is built and the code runs. */
export interface Environment {
    reflection?: Reflection;
    output: Output;
}

export const newOutput = (): Output => ({ files: [], console: [] });

const AVAILABLE = "'langium', 'langium/generate', 'langium/lsp', './generated/ast.js', 'node:fs', 'node:path', './cli-util.js'";

// ---- the modules user code can import

/** `./generated/ast.js`: type guards and type constants, answered from the interpreted grammar. */
function astModule(env: Environment) {
    const reflection = () => {
        if (!env.reflection) throw new Error('The AST types are not available yet: use them inside functions, not at the top of the file.');
        return env.reflection;
    };
    return new Proxy({}, {
        get(_target, key) {
            if (typeof key !== 'string') return undefined;
            if (key === '__esModule') return true;
            if (key === 'reflection') return reflection();
            const known = (type: string) => reflection().getAllTypes().includes(type);
            if (key.startsWith('is') && known(key.slice(2))) return (node: unknown) => reflection().isInstance(node, key.slice(2));
            if (known(key)) {
                const properties = Object.keys(reflection().getTypeMetaData(key).properties ?? {});
                return Object.freeze({ $type: key, ...Object.fromEntries(properties.map(p => [p, p])) });
            }
            throw new Error(`'${key}' is not exported by ./generated/ast.js: the grammar defines no such type. Types: ${reflection().getAllTypes().join(', ')}.`);
        },
    });
}

/** `node:fs`: files are not written to a disk but collected, to be shown. */
function fsModule(env: Environment) {
    const write = (path: unknown, data: unknown) => {
        const p = String(path);
        const existing = env.output.files.find(f => f.path === p);
        if (existing) existing.content = String(data); else env.output.files.push({ path: p, content: String(data) });
    };
    const fs = {
        writeFileSync: write,
        appendFileSync: (path: unknown, data: unknown) => write(path, (env.output.files.find(f => f.path === String(path))?.content ?? '') + String(data)),
        existsSync: () => true,
        mkdirSync: () => undefined,
        readFileSync: (path: unknown) => {
            const file = env.output.files.find(f => f.path === String(path));
            if (!file) throw new Error(`readFileSync: '${path}' does not exist (in the playground, only files written by the generator can be read).`);
            return file.content;
        },
    };
    return { ...fs, default: fs, __esModule: true };
}

const pathModule = (() => {
    const join = (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/').replace(/(^|\/)\.\//g, '$1');
    const basename = (p: string, ext = '') => { const b = p.split(/[\\/]/).pop() ?? ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
    const extname = (p: string) => /\.[^./\\]+$/.exec(basename(p))?.[0] ?? '';
    const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || '.';
    const path = { join, resolve: join, basename, extname, dirname, sep: '/', parse: (p: string) => ({ dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p, extname(p)) }) };
    return { ...path, default: path, __esModule: true };
})();

/** The helper of the Langium project template (src/cli/cli-util.ts) that generators call. */
const cliUtilModule = {
    __esModule: true,
    extractDestinationAndName(filePath: string, destination: string | undefined) {
        const base = pathModule.basename(filePath, pathModule.extname(filePath)).replace(/[.-]/g, '');
        return { destination: destination ?? 'generated', name: base };
    },
};

function requireFor(env: Environment) {
    return (specifier: string): unknown => {
        if (specifier === 'langium') return langiumApi;
        if (specifier === 'langium/generate') return generateApi;
        if (specifier === 'langium/lsp') return lspApi;
        if (/^(node:)?fs$/.test(specifier)) return fsModule(env);
        if (/^(node:)?path$/.test(specifier)) return pathModule;
        if (/(^|\/)ast(\.js|\.ts)?$/.test(specifier)) return astModule(env);
        if (/(^|\/)(cli-)?util(\.js|\.ts)?$/.test(specifier)) return cliUtilModule;
        throw new Error(`Cannot import '${specifier}'. In the playground a file can import: ${AVAILABLE}. (An \`import type\` of anything else is fine: types are erased.)`);
    };
}

// ---- compiling and running

/** How many lines the engine puts before the body of `new Function`: measured once, not assumed. */
const HEADER_LINES = (() => {
    try { new Function('throw new Error("x")\n//# sourceURL=playground-calibration.ts')(); } catch (e) {
        const line = /playground-calibration\.ts:(\d+)/.exec(String((e as Error).stack))?.[1];
        if (line) return Number(line) - 1;
    }
    return 2;
})();

/** Where in the user's file an error was thrown, read from its stack trace (best effort: line 1 otherwise). */
export function locate(error: unknown, file: string, code: string): CodeProblem {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const loc = (error as { loc?: { line: number; column: number } }).loc;            // Sucrase syntax errors
    if (loc) return { line: loc.line, col: loc.column + 1, message: message.replace(/\s*\(\d+:\d+\)$/, '') };
    const stack = String((error as Error)?.stack ?? '');
    const at = new RegExp(`${file.replace(/\./g, '\\.')}:(\\d+):(\\d+)`).exec(stack);
    const lines = code.split('\n').length;
    if (at) return { line: Math.min(Math.max(1, Number(at[1]) - HEADER_LINES), lines), col: Math.max(1, Number(at[2])), message };
    return { line: 1, col: 1, message };
}

export interface Loaded { exports: Record<string, any> }

/** Erases the types, then evaluates the file as a module. Throws what the code throws. */
export function load(code: string, file: string, env: Environment): Loaded {
    const js = transform(code, { transforms: ['typescript', 'imports'], filePath: file, preserveDynamicImport: true }).code;
    const module = { exports: {} as Record<string, any> };
    const print = (...args: unknown[]) => { env.output.console.push(args.map(show).join(' ')); };
    const userConsole = { log: print, info: print, warn: print, error: print, debug: print, trace: print };
    new Function('require', 'exports', 'module', 'console', `${js}\n//# sourceURL=${file}`)(requireFor(env), module.exports, module, userConsole);
    return { exports: module.exports };
}

function show(value: unknown): string {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, (k, v) => k.startsWith('$') && k !== '$type' ? undefined : v, 2) ?? String(value); } catch { return String(value); }
}

/** The classes a file exports: Langium registers them as services (`services.validation.XValidator`). */
export function exportedClasses(exports: Record<string, any>): [string, new (...args: any[]) => unknown][] {
    return Object.entries(exports).filter(([, v]) => typeof v === 'function' && /^class\b/.test(Function.prototype.toString.call(v)));
}

/**
 * The function a generator file offers. In order: the default export; an exported function whose name
 * starts with generate, compile, transform, interpret, run or to (toHtml...); the only exported function.
 */
export function generatorFunction(exports: Record<string, any>): ((...args: any[]) => unknown) | undefined {
    const functions = Object.entries(exports).filter(([name, v]) => name !== 'default' && typeof v === 'function' && !/^class\b/.test(Function.prototype.toString.call(v)));
    return (typeof exports.default === 'function' ? exports.default : undefined)
        ?? functions.find(([name]) => /^(generate|compile|transform|interpret|run|to[A-Z])/.test(name))?.[1]
        ?? (functions.length === 1 ? functions[0][1] : undefined);
}

/** Calls the generator on the root of the AST, as the command line of a Langium project would. */
export async function runGenerator(fn: (...args: any[]) => unknown, root: unknown, fileName: string, env: Environment): Promise<Output> {
    env.output = newOutput();
    const returned = await fn(root, fileName, undefined);
    const output = env.output;
    if (returned !== undefined && !(typeof returned === 'string' && output.files.some(f => f.path === returned))) output.result = show(returned);
    return output;
}
