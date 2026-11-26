// The Langium side of the playground. No DOM, no worker API: this module runs the same way in
// Node (see test/analysis.test.mjs) and in the web worker (src/worker.ts).
//
// The grammar is interpreted by `createServicesForGrammar`: no generated code, and no validation
// other than what Langium does by default (lexing, parsing, linking).
import { EmptyFileSystem, GrammarAST, URI, type LangiumDocument } from 'langium';
import { createLangiumGrammarServices, createServicesForGrammar } from 'langium/grammar';

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
    ok: boolean;        // true when a parser could be built
    name: string;
    rules: number;
    problems: Problem[];
}
/** [offset, length, class, token type name] */
export type Token = [number, number, string, string];
export interface ProgramResult {
    problems: Problem[];
    /** JSON of the AST, with `$textRegion` on every node. */
    ast: string;
    tokens: Token[];
    /** What the parser reported about the grammar while analysing this program (ambiguities). */
    grammarWarnings: Problem[];
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
let current: { text: string; grammar: GrammarAST.Grammar; services: Services; terminals: Set<string>; ext: string } | undefined;
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

export async function analyzeGrammar(text: string): Promise<GrammarResult> {
    current = undefined;
    const uri = URI.parse(`memory:/grammar-${counter++}.langium`);
    const doc = grammarServices.shared.workspace.LangiumDocumentFactory.fromString<GrammarAST.Grammar>(text, uri);
    await grammarServices.shared.workspace.DocumentBuilder.build([doc], { validation: true });
    grammarServices.shared.workspace.IndexManager.remove(uri);
    const grammar = doc.parseResult.value;
    const problems = problemsOf(doc, 'grammar');
    const result: GrammarResult = { ok: false, name: grammar.name ?? '', rules: grammar.rules?.length ?? 0, problems };
    if (problems.some(p => p.severity === 'error')) return result;

    // Build the lexer and the parser now: this is where Chevrotain rejects a grammar.
    const built = await capturing(async () => {
        const services = await createServicesForGrammar({ grammar: text });
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
    const terminals = new Set(grammar.rules.filter(GrammarAST.isTerminalRule).map(r => r.name));
    current = { text, grammar, services, terminals, ext: services.LanguageMetaData.fileExtensions[0] ?? '.txt' };
    result.ok = true;
    return result;
}

/** Builds a document for the program, runs `fn` on it, then forgets it (no leak between programs). */
async function withProgram<T>(text: string, fn: (doc: LangiumDocument, services: Services) => T | Promise<T>): Promise<T> {
    if (!current) throw new Error('No valid grammar.');
    const { services, ext } = current;
    const uri = URI.parse(`memory:/program-${counter++}${ext}`);
    const doc = services.shared.workspace.LangiumDocumentFactory.fromString(text, uri);
    try {
        await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
        return await fn(doc, services);
    } finally {
        services.shared.workspace.IndexManager.remove(uri);
    }
}

function classify(type: string, image: string, terminals: Set<string>, hidden: boolean): string {
    if (hidden) return /^\s*$/.test(image) ? '' : 'comment';
    if (!terminals.has(type)) return /^\w/.test(image) ? 'keyword' : 'punct';
    if (/^["'`]/.test(image)) return 'string';
    if (/^[-+]?\.?\d/.test(image)) return 'number';
    return 'terminal';
}

export async function analyzeProgram(text: string): Promise<ProgramResult> {
    const terminals = current!.terminals;
    const run = await capturing(() => withProgram(text, (doc, services) => {
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
        return { problems: problemsOf(doc, 'validation'), ast, tokens };
    }));
    if (run.error || !run.value) throw run.error ?? new Error('Analysis failed.');
    const { text: grammarText, grammar } = current!;
    const grammarWarnings = [...new Set(run.printed.flatMap(split))]
        .map(m => positioned(grammarText, locate(grammarText, grammar, m), 'warning', 'chevrotain', m));
    return { ...run.value, grammarWarnings };
}

export async function complete(text: string, offset: number): Promise<Completion[]> {
    if (!current) return [];
    const run = await capturing(() => withProgram(text, async (doc, services) => {
        const provider = services.lsp?.CompletionProvider;
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
    }));
    return run.value ?? [];
}
