// The page: two editors, their problem lists and the syntax tree. Langium itself runs in a worker
// (src/worker.ts). Three rules keep the display honest:
//   1. one analysis at a time, and a result is shown only if the text it was computed from is
//      still the text in the editor (no stale AST);
//   2. an analysis that takes too long is abandoned and the worker replaced (no frozen page);
//   3. when the grammar is invalid, programs are not analysed and the page says so.
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState, Prec, StateEffect, StateField, type Extension, type TransactionSpec } from '@codemirror/state';
import { Decoration, type DecorationSet, hoverTooltip, keymap } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { EditorView, basicSetup } from 'codemirror';
import type { Completion, Edit, GrammarResult, Problem, ProgramResult, Span, Token } from './analysis';
import { EXAMPLES } from './examples';
import { generatorStarter, newLanguage, validatorStarter } from './starter';
import type { Sources, TsCompletions, TsLocation, TsProblem, TsRename } from './tsservice';
import type { TsRequest } from './tsworker';
import type { Request } from './worker';

declare const __LANGIUM_VERSION__: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};

// ---------------------------------------------------------------- worker client

const GRAMMAR_TIMEOUT = 10_000;
const PROGRAM_TIMEOUT = 6_000;

class TimeoutError extends Error {}

class Engine {
    private worker!: Worker;
    private seq = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
    private readonly url: string;
    lastMs = 0;

    /** `sourceId`: the element that holds the worker's code. `boot`: a first message for each new worker. */
    constructor(sourceId: string, private readonly boot?: () => object) {
        this.url = URL.createObjectURL(new Blob([$(sourceId).textContent ?? ''], { type: 'text/javascript' }));
        this.start();
    }

    private start() {
        this.worker = new Worker(this.url);
        if (this.boot) this.worker.postMessage({ id: 0, type: 'init', ...this.boot() });
        this.worker.onmessage = e => {
            const p = this.pending.get(e.data.id);
            if (!p) return;
            this.pending.delete(e.data.id);
            clearTimeout(p.timer);
            this.crashes = 0;
            if (e.data.ok) { this.lastMs = e.data.ms; p.resolve(e.data.result); } else p.reject(new Error(e.data.error));
        };
        this.worker.onerror = e => {
            // A worker that keeps crashing without ever answering is not started again.
            if (++this.crashes > 3) { this.dead = true; this.worker.terminate(); this.failAll(new Error(e.message || 'The worker cannot start.')); return; }
            this.restart(new Error(e.message || 'The analyser crashed.'));
        };
    }

    private crashes = 0;
    private dead = false;
    private failAll(reason: Error) {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
        this.pending.clear();
    }

    /** Number of times the worker was replaced: a new worker has no grammar yet. */
    restarts = 0;

    private restart(reason: Error) {
        this.restarts++;
        this.worker.terminate();
        this.failAll(reason);
        this.start();
    }

    /** An analysis that times out costs the worker its life; an editor feature that times out is just dropped. */
    call<T>(type: Request['type'] | TsRequest['type'], text: string, timeout: number, extra: object = {}): Promise<T> {
        const id = ++this.seq;
        if (this.dead) return Promise.reject(new Error('The worker could not be started.'));
        return new Promise<T>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                if (type === 'grammar' || type === 'program') return this.restart(new TimeoutError());
                this.pending.delete(id);
                reject(new TimeoutError());
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({ ...extra, id, type, text });
        });
    }
}

const engine = new Engine('worker-source');

// ---------------------------------------------------------------- state

interface Tab {
    name: string;
    state: EditorState;
    rev: number;                 // incremented at every edit
    dirty: boolean;
    result?: ProgramResult;      // valid for (resultRev, resultGrammarRev)
    resultRev: number;
    resultGrammarRev: number;
    failure?: string;            // the analysis of (failedKey) failed with this message
    failedKey?: string;
    open: Map<string, boolean>;  // tree nodes the user opened or closed
    runOnce?: boolean;           // "Run" was pressed: run the generator at the next analysis, whatever the setting
}

const grammar = { rev: 0, dirty: true, result: undefined as GrammarResult | undefined, resultRev: -1, failure: '' };
let tabs: Tab[] = [];
let active = 0;
let astView: 'tree' | 'json' | 'output' = 'tree';
/** Whether the generator runs at every change, or only when "Run" is pressed (a preference of this browser). */
const AUTO_RUN_KEY = 'langium-playground-standalone:auto-run';
let autoRun = (() => { try { return localStorage.getItem(AUTO_RUN_KEY) !== 'off'; } catch { return true; } })();
let busy = false;
let timer = 0;
let builtIn = -1;                // value of engine.restarts when the grammar was last built
let shown: Tab | undefined;      // the tab whose problems and tree are on screen

const tab = () => tabs[active];
const textOf = (t: Tab) => t.state.doc.toString();
const fresh = (t: Tab) => !!t.result && t.resultRev === t.rev && t.resultGrammarRev === grammar.rev && grammar.result?.ok === true;

// ---------------------------------------------------------------- editors

/** A small tokenizer for the Langium grammar language (colours only). */
const GRAMMAR_KEYWORDS = new Set(['grammar', 'entry', 'terminal', 'hidden', 'fragment', 'returns', 'interface', 'type', 'extends',
    'import', 'infer', 'infers', 'with', 'current', 'true', 'false', 'infix', 'on', 'left', 'right', 'assoc', 'EOF']);
const grammarLanguage = StreamLanguage.define<{ block: boolean }>({
    startState: () => ({ block: false }),
    token(stream, state) {
        if (state.block) {
            if (stream.skipTo('*/')) { stream.match('*/'); state.block = false; } else stream.skipToEnd();
            return 'comment';
        }
        if (stream.eatSpace()) return null;
        if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
        if (stream.match('/*')) { state.block = true; return 'comment'; }
        const ch = stream.next()!;
        if (ch === '"' || ch === "'") {
            let c: string | void;
            while ((c = stream.next()) != null) { if (c === '\\') stream.next(); else if (c === ch) break; }
            return 'string';
        }
        if (ch === '/') {
            let c: string | void, cls = false;
            while ((c = stream.next()) != null) {
                if (c === '\\') stream.next();
                else if (c === '[') cls = true;
                else if (c === ']') cls = false;
                else if (c === '/' && !cls) break;
            }
            stream.eatWhile(/[a-z]/);
            return 'regexp';
        }
        if (/[A-Za-z_]/.test(ch)) {
            stream.eatWhile(/\w/);
            const word = stream.current();
            if (GRAMMAR_KEYWORDS.has(word)) return 'keyword';
            if (stream.match(/^\s*(\+=|\?=|=(?!>))/, false)) return 'propertyName';
            return /^[A-Z]/.test(word) ? 'typeName' : null;
        }
        if (/\d/.test(ch)) { stream.eatWhile(/\d/); return 'number'; }
        return 'operator';
    },
});

const setTokens = StateEffect.define<Token[]>();
const tokenField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        value = value.map(tr.changes);
        for (const e of tr.effects) {
            if (e.is(setTokens)) {
                const max = tr.state.doc.length;
                value = Decoration.set(e.value.filter(t => t[1] > 0 && t[0] + t[1] <= max)
                    .map(t => Decoration.mark({ class: 'tok-' + t[2] }).range(t[0], t[0] + t[1])), true);
            }
        }
        return value;
    },
    provide: f => EditorView.decorations.from(f),
});

const setHighlight = StateEffect.define<{ from: number; to: number } | null>();
const highlightField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        if (tr.docChanged) value = Decoration.none;
        for (const e of tr.effects) {
            if (e.is(setHighlight)) {
                const r = e.value;
                value = r && r.to > r.from && r.to <= tr.state.doc.length
                    ? Decoration.set([Decoration.mark({ class: 'cm-ast-hl' }).range(r.from, r.to)]) : Decoration.none;
            }
        }
        return value;
    },
    provide: f => EditorView.decorations.from(f),
});

/** What the lexer made of the text under the mouse: keyword or terminal. */
const tokenTooltip = hoverTooltip((_view, pos) => {
    const t = tab();
    if (!fresh(t)) return null;
    const tok = t.result!.tokens.find(k => k[0] <= pos && pos < k[0] + k[1]);
    if (!tok) return null;
    return {
        pos: tok[0], end: tok[0] + tok[1], above: true,
        create() {
            const dom = el('div', 'tok-tip');
            const kind = tok[2] === 'keyword' || tok[2] === 'punct' ? 'keyword ' : tok[2] === 'comment' ? 'hidden terminal ' : 'terminal ';
            dom.append(kind, el('code', '', tok[2] === 'keyword' || tok[2] === 'punct' ? `'${tok[3]}'` : tok[3]));
            return { dom };
        },
    };
});

// ---- editor features: completion, go to definition, occurrences, rename, hover, formatting.
// The same code serves both editors: `side` says whether Langium's grammar language or the
// language defined by the grammar answers. Each answer is used only if the text did not change.

type Side = 'grammar' | 'program';

/** The program side can answer only when the worker holds the grammar that is on screen. */
const ready = (side: Side) => side === 'grammar'
    || (grammar.result?.ok === true && grammar.resultRev === grammar.rev && builtIn === engine.restarts);

async function ask<T>(type: Request['type'], side: Side, view: EditorView, fallback: T, extra: Partial<Request> = {}): Promise<T> {
    if (!ready(side)) return fallback;
    const doc = view.state.doc;
    try {
        const result = await engine.call<T>(type, doc.toString(), 3000, { target: side, ...extra });
        return view.state.doc === doc ? result : fallback;
    } catch { return fallback; }
}

const completionsFor = (side: Side) => async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(/[\w-]+/);
    if (!ctx.explicit && !word) return null;
    if (!ready(side)) return null;
    let items: Completion[] = [];
    try { items = await engine.call<Completion[]>('complete', ctx.state.doc.toString(), 3000, { target: side, offset: ctx.pos }); } catch { return null; }
    if (ctx.aborted || !items.length) return null;
    return {
        from: Math.min(ctx.pos, ...items.map(i => i.from)),
        validFor: /^[\w-]*$/,
        options: items.map(i => ({ label: i.label, detail: i.detail, type: i.kind === 'keyword' ? 'keyword' : i.kind === 'reference' ? 'variable' : 'text', apply: i.insert })),
    };
};

async function goToDefinition(view: EditorView, side: Side, offset = view.state.selection.main.head) {
    const span = await ask<Span | null>('definition', side, view, null, { offset });
    if (!span) { toast(ready(side) ? 'No definition found here.' : 'Not available while the grammar has errors.'); return; }
    view.dispatch({ selection: { anchor: span.from, head: span.to }, scrollIntoView: true });
    view.focus();
}

async function renameSymbol(view: EditorView, side: Side) {
    const offset = view.state.selection.main.head;
    const target = await ask<(Span & { name: string }) | null>('renameTarget', side, view, null, { offset });
    if (!target) { toast(ready(side) ? 'Nothing to rename here: put the cursor on a name.' : 'Not available while the grammar has errors.'); return; }
    const name = prompt(`Rename "${target.name}" to:`, target.name)?.trim();
    if (!name || name === target.name) return;
    const edits = await ask<Edit[]>('rename', side, view, [], { offset, name });
    if (!edits.length) { toast('The rename could not be done.'); return; }
    view.dispatch({ changes: edits.map(e => ({ from: e.from, to: e.to, insert: e.insert })), userEvent: 'input.rename' });
    toast(`"${target.name}" renamed to "${name}" in ${edits.length} place${edits.length > 1 ? 's' : ''}.`);
    view.focus();
}

async function formatText(view: EditorView, side: Side) {
    const before = view.state.doc.toString();
    const edits = await ask<Edit[]>('format', side, view, []);
    if (edits.length) view.dispatch({ changes: edits.map(e => ({ from: e.from, to: e.to, insert: e.insert })), userEvent: 'input.format' });
    toast(view.state.doc.toString() !== before ? 'Formatted.' : 'Nothing to format (a text with syntax errors is left as it is).');
}

const setOccurrences = StateEffect.define<Span[]>();
const occurrenceField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        if (tr.docChanged) value = Decoration.none;
        for (const e of tr.effects) {
            if (e.is(setOccurrences)) {
                const max = tr.state.doc.length;
                value = Decoration.set(e.value.filter(s => s.to > s.from && s.to <= max)
                    .map(s => Decoration.mark({ class: 'cm-occurrence' }).range(s.from, s.to)), true);
            }
        }
        return value;
    },
    provide: f => EditorView.decorations.from(f),
});

function features(side: Side): Extension {
    let timer = 0;
    const keys = [
        { key: 'F12', run: (view: EditorView) => { void goToDefinition(view, side); return true; } },
        { key: 'F2', run: (view: EditorView) => { void renameSymbol(view, side); return true; } },
    ];
    if (side === 'grammar') keys.push({ key: 'Shift-Alt-f', run: (view: EditorView) => { void formatText(view, side); return true; } });
    return [
        occurrenceField,
        autocompletion({ override: [completionsFor(side)] }),
        Prec.high(keymap.of(keys)),
        // Ctrl-click (Cmd-click on a Mac): go to the definition.
        Prec.highest(EditorView.domEventHandlers({
            mousedown(event, view) {
                if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
                const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (offset == null) return false;
                event.preventDefault();
                void goToDefinition(view, side, offset);
                return true;
            },
        })),
        // The name under the cursor: its declaration and its uses are marked.
        EditorView.updateListener.of(u => {
            if (!u.selectionSet && !u.docChanged) return;
            clearTimeout(timer);
            const view = u.view;
            timer = window.setTimeout(async () => {
                const sel = view.state.selection.main;
                const spans = sel.empty && view.hasFocus ? await ask<Span[]>('occurrences', side, view, [], { offset: sel.head }) : [];
                if (view.state.selection.main.head !== sel.head) return;
                view.dispatch({ effects: setOccurrences.of(spans.length > 1 ? spans : []) });
            }, 250);
        }),
        // Documentation comment of what is under the mouse.
        hoverTooltip(async (view, pos) => {
            const text = await ask<string>('hover', side, view, '', { offset: pos });
            if (!text) return null;
            return { pos, above: true, create: () => ({ dom: el('div', 'tok-tip doc', text.replace(/^```\w*\n?|```$/gm, '').trim()) }) };
        }),
    ];
}

const common: Extension = [basicSetup, keymap.of([indentWithTab]), EditorView.lineWrapping, syntaxHighlighting(classHighlighter)];

const grammarView = new EditorView({
    parent: $('grammar-editor'),
    state: EditorState.create({
        extensions: [common, grammarLanguage, features('grammar'), EditorView.updateListener.of(u => {
            if (!u.docChanged) return;
            grammar.rev++; grammar.dirty = true;
            schedule(300);
        })],
    }),
});

// The validator and the generator: TypeScript, written as in a Langium project. A change there is
// handled like a change of the grammar: the language is rebuilt and every program analysed again.
type CodeSide = 'validator' | 'generator';
type Left = 'grammar' | CodeSide | 'ast';

// ---- TypeScript assistance in these two files: completion, types on hover, type errors, go to
// definition, rename. A TypeScript language service runs in a worker of its own, started the first
// time it is needed. It only informs: the code is run whatever it says.

let tsEngine: Engine | undefined;
const tsService = () => tsEngine ??= new Engine('ts-worker-source', () => ({ libs: JSON.parse($('ts-libs').textContent || '{}') }));
/** The AST types of the last valid grammar (kept while the grammar is being edited). */
const astTypes = { text: '', name: '' };
const tsProblems: Record<CodeSide, Problem[]> = { validator: [], generator: [] };
const tsSources = (): Sources => ({ validator: codeOf('validator'), generator: codeOf('generator'), ast: astTypes.text, name: astTypes.name });

async function askTs<T>(type: TsRequest['type'], side: CodeSide, fallback: T, offset = 0): Promise<T> {
    const view = leftViews[side], doc = view.state.doc;
    try {
        const result = await tsService().call<T>(type, '', 10_000, { sources: tsSources(), file: side, offset });
        return view.state.doc === doc ? result : fallback;
    } catch { return fallback; }
}

let tsTimer = 0;
function scheduleTs() {
    clearTimeout(tsTimer);
    tsTimer = window.setTimeout(refreshTs, 400);
}
/** Type-checks the two files. The first call also starts the service, which takes a moment. */
async function refreshTs() {
    if (!codeOf('validator').trim() && !codeOf('generator').trim()) {
        tsProblems.validator = []; tsProblems.generator = [];
        renderGrammar();
        return;
    }
    const docs = [leftViews.validator.state.doc, leftViews.generator.state.doc];
    try {
        const found = await tsService().call<Record<CodeSide, TsProblem[]>>('diagnostics', '', 30_000, { sources: tsSources() });
        if (docs[0] !== leftViews.validator.state.doc || docs[1] !== leftViews.generator.state.doc) return;    // edited meanwhile
        for (const side of ['validator', 'generator'] as const) tsProblems[side] = found[side].map(p => ({ ...p, source: 'typescript' }));
    } catch { return; }      // the page works without the type checker
    renderGrammar();
}

async function tsDefinition(side: CodeSide, offset: number) {
    const target = await askTs<TsLocation | null>('definition', side, null, offset);
    if (!target) { toast('No definition to show here (what Langium declares is not shown in the page).'); return; }
    if (target.file !== left) selectLeft(target.file);
    const view = leftViews[target.file], max = view.state.doc.length;
    view.dispatch({ selection: { anchor: Math.min(target.from, max), head: Math.min(target.to, max) }, scrollIntoView: true });
    view.focus();
}

async function tsRename(side: CodeSide) {
    const view = leftViews[side];
    const found = await askTs<TsRename | null>('rename', side, null, view.state.selection.main.head);
    if (!found) { toast('Nothing to rename here: put the cursor on a name declared in this file.'); return; }
    const name = prompt(`Rename "${found.name}" to:`, found.name)?.trim();
    if (!name || name === found.name) return;
    view.dispatch({ changes: found.spans.map(s => ({ from: s.from, to: s.to, insert: name })), userEvent: 'input.rename' });
    toast(`"${found.name}" renamed to "${name}" in ${found.spans.length} place${found.spans.length > 1 ? 's' : ''}.`);
    view.focus();
}

function tsFeatures(side: CodeSide): Extension {
    return [
        autocompletion({
            override: [async (ctx: CompletionContext): Promise<CompletionResult | null> => {
                // After a name, a dot, or inside a string (the properties `accept` can point to).
                if (!ctx.explicit && !ctx.matchBefore(/[\w$]+|\.|['"]/)) return null;
                const found = await askTs<TsCompletions | null>('complete', side, null, ctx.pos);
                if (ctx.aborted || !found?.items.length) return null;
                return { from: Math.min(found.from, ctx.pos), validFor: /^[\w$]*$/, options: found.items.map(i => ({ label: i.label, type: i.kind, detail: i.detail })) };
            }],
        }),
        Prec.high(keymap.of([
            { key: 'F12', run: view => { void tsDefinition(side, view.state.selection.main.head); return true; } },
            { key: 'F2', run: () => { void tsRename(side); return true; } },
        ])),
        Prec.highest(EditorView.domEventHandlers({
            mousedown(event, view) {
                if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
                const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (offset == null) return false;
                event.preventDefault();
                void tsDefinition(side, offset);
                return true;
            },
        })),
        hoverTooltip(async (_view, pos) => {
            const text = await askTs<string>('hover', side, '', pos);
            if (!text) return null;
            return { pos, above: true, create: () => ({ dom: el('div', 'tok-tip doc code', text) }) };
        }),
    ];
}

const codeView = (host: string, side: CodeSide) => new EditorView({
    parent: $(host),
    state: EditorState.create({
        extensions: [common, javascript({ typescript: true }), tsFeatures(side), EditorView.updateListener.of(u => {
            if (!u.docChanged) return;
            grammar.rev++; grammar.dirty = true;
            tsProblems[side] = [];
            schedule(500);
            scheduleTs();
        })],
    }),
});
/** Read-only: the TypeScript types of the AST, as `langium generate` would write them. */
const astTypesView = new EditorView({
    parent: $('ast-editor'),
    state: EditorState.create({ extensions: [common, javascript({ typescript: true }), EditorState.readOnly.of(true)] }),
});
const leftViews: Record<Left, EditorView> = {
    grammar: grammarView, validator: codeView('validator-editor', 'validator'), generator: codeView('generator-editor', 'generator'), ast: astTypesView,
};
const LEFT: Left[] = ['grammar', 'validator', 'generator', 'ast'];
let left: Left = 'grammar';
/** False for code that came with a share link, until the user agrees to run it. */
let codeAllowed = true;
const codeOf = (side: CodeSide) => leftViews[side].state.doc.toString();

const programExtensions: Extension = [common, tokenField, highlightField, tokenTooltip, features('program'),
    EditorView.updateListener.of(u => {
        const t = tab();
        if (!t) return;
        t.state = u.state;
        if (u.docChanged) { t.rev++; t.dirty = true; renderTabs(); schedule(150); }
        if (u.selectionSet && u.view.hasFocus) syncCursor();
    })];

const programView = new EditorView({ parent: $('program-editor'), state: EditorState.create({ extensions: programExtensions }) });

function newTab(name: string, text: string): Tab {
    return { name, state: EditorState.create({ doc: text, extensions: programExtensions }), rev: 0, dirty: true, resultRev: -1, resultGrammarRev: -1, open: new Map() };
}

/** Applies a transaction to a tab, whether it is the one on screen or not. */
function apply(t: Tab, spec: TransactionSpec) {
    if (t === tab()) programView.dispatch(spec); else t.state = t.state.update(spec).state;
}

function toDiagnostics(problems: Problem[], length: number): Diagnostic[] {
    return problems.map(p => {
        let from = Math.min(p.from, length), to = Math.min(Math.max(p.to, from), length);
        if (from === to) { if (to < length) to++; else if (from > 0) from--; }
        return { from, to, severity: p.severity, message: p.message, source: p.source };
    });
}

// ---------------------------------------------------------------- analysis loop

function schedule(delay: number) {
    save();
    clearTimeout(timer);
    timer = window.setTimeout(pump, delay);
}

async function pump() {
    if (busy) return;
    busy = true;
    try {
        for (;;) {
            // The worker was replaced since the grammar was built: build it again there.
            if (grammar.result?.ok && builtIn !== engine.restarts) grammar.dirty = true;
            if (grammar.dirty) {
                grammar.dirty = false;
                const rev = grammar.rev;
                let result: GrammarResult | undefined, failure = '';
                try {
                    result = await engine.call<GrammarResult>('grammar', grammarView.state.doc.toString(), GRAMMAR_TIMEOUT,
                        codeAllowed ? { validator: codeOf('validator'), generator: codeOf('generator') } : {});
                    builtIn = engine.restarts;
                } catch (e) {
                    failure = e instanceof TimeoutError
                        ? `The grammar (with its validator and generator) could not be loaded in ${GRAMMAR_TIMEOUT / 1000} s. The analyser was restarted; edit the grammar or the code to try again.`
                        : `The analyser failed on this grammar: ${(e as Error).message}`;
                }
                // An example or a new language without validator or generator: give it files to fill.
                // (This edits the code tabs, so this result becomes stale and the loop goes round again.)
                if (wantStarters && result?.ok && rev === grammar.rev) {
                    wantStarters = false;
                    for (const side of ['validator', 'generator'] as const) {
                        if (!codeOf(side).trim()) leftViews[side].dispatch({ changes: { from: 0, insert: starter(side, result) } });
                    }
                }
                if (rev !== grammar.rev) continue;          // edited meanwhile: this result is stale
                grammar.result = result; grammar.resultRev = rev; grammar.failure = failure;
                if (result?.astSource && (result.astSource !== astTypes.text || result.name !== astTypes.name)) {
                    // New AST types: show them, and check the validator and the generator against them.
                    astTypes.text = result.astSource; astTypes.name = result.name;
                    astTypesView.dispatch({ changes: { from: 0, to: astTypesView.state.doc.length, insert: result.astSource } });
                    scheduleTs();
                }
                for (const t of tabs) t.dirty = true;
                renderGrammar(); renderProgram(); renderTabs();
                continue;
            }
            if (!grammar.result?.ok) break;
            const t = [tab(), ...tabs].find(x => x && x.dirty);
            if (!t) break;
            t.dirty = false;
            const rev = t.rev, grev = grammar.rev, key = `${grev}:${rev}`;
            if (t.failedKey === key) continue;              // already failed on exactly this input
            try {
                const run = autoRun || !!t.runOnce;
                t.runOnce = false;
                const result = await engine.call<ProgramResult>('program', textOf(t), PROGRAM_TIMEOUT, { name: t.name, run });
                if (!tabs.includes(t) || rev !== t.rev || grev !== grammar.rev) continue;
                t.result = result; t.resultRev = rev; t.resultGrammarRev = grev; t.failure = undefined; t.failedKey = undefined;
                apply(t, { effects: setTokens.of(result.tokens) });
                apply(t, setDiagnostics(t.state, toDiagnostics(result.problems, t.state.doc.length)));
            } catch (e) {
                const timeout = e instanceof TimeoutError;
                if (!tabs.includes(t) || rev !== t.rev || grev !== grammar.rev) continue;
                t.failedKey = key;
                t.failure = timeout
                    ? `This program could not be analysed in ${PROGRAM_TIMEOUT / 1000} s (a terminal regular expression that backtracks a lot, a loop in the grammar, or a loop in the validator or the generator). The analyser was restarted; edit the program, the grammar or the code to try again.`
                    : `The analyser failed on this program: ${(e as Error).message}`;
                apply(t, setDiagnostics(t.state, []));
            }
            $('timing').textContent = `last analysis ${engine.lastMs.toFixed(0)} ms`;
            renderGrammar(); renderTabs();
            if (t === tab()) renderProgram();
        }
    } finally {
        busy = false;
    }
    if (grammar.dirty || (grammar.result?.ok && tabs.some(t => t.dirty && t.failedKey !== `${grammar.rev}:${t.rev}`))) schedule(0);
}

// ---------------------------------------------------------------- rendering

const SEV = { error: '✕', warning: '!', info: 'i' } as const;

function problemList(host: HTMLElement, problems: Problem[], view: EditorView, okText: string, banner?: string) {
    host.replaceChildren();
    if (banner) host.append(el('div', 'banner', banner));
    if (!problems.length) {
        if (!banner) host.append(el('div', 'none ok', okText));
        return;
    }
    for (const p of problems) {
        const row = el('button', `problem ${p.severity}`);
        row.append(el('span', 'sev', SEV[p.severity]), el('span', 'pos', `${p.line}:${p.col}`), el('span', 'msg', p.message), el('span', 'src', p.source));
        row.title = 'Go to this position';
        row.onclick = () => {
            const len = view.state.doc.length;
            const from = Math.min(p.from, len), to = Math.min(Math.max(p.to, from), len);
            view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
            view.focus();
        };
        host.append(row);
    }
}

function chip(host: HTMLElement, cls: string, text: string) { host.className = 'chip ' + cls; host.textContent = text; }
const count = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Grammar problems: Langium's, plus what the parser reported while analysing the programs. */
function grammarProblems(): Problem[] {
    const own = grammar.result?.problems ?? [];
    const seen = new Set<string>();
    const extra = tabs.filter(fresh).flatMap(t => t.result!.grammarWarnings).filter(p => !seen.has(p.message) && !!seen.add(p.message));
    return [...own, ...extra].sort((a, b) => a.from - b.from);
}

/** Generator problems: when it was loaded, plus where it failed on a program. */
function generatorProblems(): Problem[] {
    const seen = new Set<string>();
    const runtime = tabs.filter(fresh).flatMap(t => t.result!.generatorProblems).filter(p => !seen.has(p.line + p.message) && !!seen.add(p.line + p.message));
    return [...(grammar.result?.generator ?? []), ...runtime];
}

const worst = (problems: Problem[]): '' | 'ok' | 'warning' | 'error' =>
    problems.some(p => p.severity === 'error') ? 'error' : problems.some(p => p.severity === 'warning') ? 'warning' : 'ok';

/** A file to start from, with the names, node types and properties of the grammar on screen. */
function starter(side: CodeSide, r: GrammarResult | undefined = grammar.result): string {
    const info = { name: r?.name ?? '', entry: r?.entry ?? '', types: r?.types ?? [] };
    return side === 'validator' ? validatorStarter(info) : generatorStarter(info);
}

function renderGrammar() {
    for (const side of LEFT) {
        if (side === 'ast') {
            if (left === 'ast') $('grammar-problems').replaceChildren(el('div', 'none',
                'Read-only. The TypeScript types of the AST, derived from the grammar: what `langium generate` writes in src/language/generated/ast.ts. The validator and the generator import them from \'./generated/ast.js\'.'));
            continue;
        }
        const dot = document.querySelector<HTMLElement>(`[data-left="${side}"] .dot`)!;
        if (grammar.resultRev !== grammar.rev) continue;
        const problems = (side === 'grammar' ? grammarProblems()
            : side === 'validator' ? [...(grammar.result?.validator ?? []), ...tsProblems.validator]
            : [...generatorProblems(), ...tsProblems.generator]).sort((a, b) => a.from - b.from);
        const view = leftViews[side];
        view.dispatch(setDiagnostics(view.state, toDiagnostics(problems, view.state.doc.length)));
        const empty = side !== 'grammar' && !view.state.doc.toString().trim();
        dot.className = 'dot ' + (empty || !grammar.result || (side !== 'grammar' && !codeAllowed) ? '' : worst(problems));
        if (side !== left) continue;
        const host = $('grammar-problems');
        if (side !== 'grammar' && empty) {
            // Nothing written yet: say what this file is for, and offer a starting point.
            host.replaceChildren(el('div', 'none', side === 'validator'
                ? 'No validator. A validator checks what the grammar cannot say; its errors and warnings appear in the programs.'
                : 'No generator. A generator receives the AST of a valid program and produces text or files, shown in "Output".'));
            const b = el('button', 'starter', 'Insert a starting point');
            b.onclick = () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: starter(side) } }); view.focus(); };
            host.firstElementChild!.append(' ', b);
            continue;
        }
        const okText = side !== 'grammar' && !codeAllowed ? `This ${side} has not been run yet.` : `No problem in the ${side}.`;
        problemList(host, problems, view, okText, grammar.failure || undefined);
    }
    $('consent').hidden = codeAllowed;
    if (grammar.resultRev !== grammar.rev) return;
    const problems = grammarProblems();
    const errors = problems.filter(p => p.severity === 'error').length, warnings = problems.filter(p => p.severity === 'warning').length;
    const r = grammar.result;
    if (!r) chip($('grammar-chip'), 'error', 'not analysed');
    else if (errors) chip($('grammar-chip'), 'error', count(errors, 'error'));
    else if (warnings) chip($('grammar-chip'), 'warning', `${r.name} · ${count(warnings, 'warning')}`);
    else chip($('grammar-chip'), 'ok', `✓ ${r.name} · ${count(r.rules, 'rule')}`);
}

function selectLeft(side: Left) {
    left = side;
    for (const s of LEFT) {
        $(`${s}-editor`).hidden = s !== side;
        document.querySelector(`[data-left="${s}"]`)!.setAttribute('aria-selected', String(s === side));
    }
    $('format').hidden = side !== 'grammar';
    $('download-grammar').textContent = side === 'ast' ? 'Download ast.ts' : `Download ${side}`;
    if (side === 'validator' || side === 'generator') tsService();      // start the type checker before it is asked something
    leftViews[side].requestMeasure();
    $('grammar-problems').replaceChildren();
    renderGrammar();
    leftViews[side].focus();
}

function statusOf(t: Tab): '' | 'ok' | 'warning' | 'error' {
    if (t.failure && t.failedKey === `${grammar.rev}:${t.rev}`) return 'error';
    if (!fresh(t)) return '';
    return t.result!.problems.some(p => p.severity === 'error') ? 'error' : t.result!.problems.some(p => p.severity === 'warning') ? 'warning' : 'ok';
}

function renderTabs() {
    const host = $('tabs');
    host.replaceChildren();
    tabs.forEach((t, i) => {
        const b = el('div', 'tab');
        b.setAttribute('role', 'tab'); b.tabIndex = 0;
        b.setAttribute('aria-selected', String(i === active));
        const s = statusOf(t);
        const dot = el('span', 'dot ' + s);
        dot.title = s === 'ok' ? 'Accepted' : s === 'error' ? 'Rejected' : s === 'warning' ? 'Accepted with warnings' : 'Not analysed';
        b.append(dot, el('span', '', t.name));
        b.title = 'Double-click to rename';
        b.onclick = () => select(i);
        b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); } };
        b.ondblclick = () => {
            const name = prompt('Name of this program', t.name)?.trim();
            if (name) { t.name = name; renderTabs(); save(); }
        };
        if (tabs.length > 1) {
            const x = el('button', 'x', '×');
            x.title = 'Close this program'; x.setAttribute('aria-label', `Close ${t.name}`);
            x.onclick = e => {
                e.stopPropagation();
                if (textOf(t).trim() && !confirm(`Delete the program "${t.name}"?`)) return;
                tabs.splice(i, 1);
                if (active >= tabs.length || i < active) active = Math.max(0, active - 1);
                programView.setState(tab().state);
                renderTabs(); renderProgram(); renderGrammar(); save();
            };
            b.append(x);
        }
        host.append(b);
    });
}

function select(i: number) {
    if (i === active) return;
    active = i;
    programView.setState(tab().state);
    renderTabs(); renderProgram(); save();
    programView.focus();
}

function renderProgram() {
    const t = tab();
    const host = $('program-problems'), ast = $('ast');
    const grammarPending = grammar.resultRev !== grammar.rev;
    const previous = shown;
    shown = t;
    if (!grammarPending && !grammar.result?.ok) {
        const blocker = grammar.result?.validator.some(p => p.severity === 'error') ? 'validator' : 'grammar';
        problemList(host, [], programView, '', `The ${blocker} has errors: programs are not analysed until it is fixed.`);
        ast.classList.add('stale');
        renderAst(t, 'The grammar has errors. This tree comes from an earlier analysis.');
        chip($('ast-chip'), 'error', 'out of date');
        return;
    }
    if (t.failure && t.failedKey === `${grammar.rev}:${t.rev}`) {
        problemList(host, [], programView, '', t.failure);
        ast.classList.add('stale');
        renderAst(t, 'No tree: the analysis of this program failed.');
        chip($('ast-chip'), 'error', 'out of date');
        return;
    }
    if (!fresh(t)) {
        // Analysis under way. While typing, keep what is on screen for a moment; but never leave
        // the tree of another program there.
        if (previous !== t) {
            host.replaceChildren(el('div', 'none', 'Analysing…'));
            ast.replaceChildren();
            chip($('ast-chip'), '', 'analysing…');
        }
        return;
    }
    const problems = t.result!.problems;
    problemList(host, problems, programView, 'No problem: the program is accepted by the grammar.');
    ast.classList.remove('stale');
    const errors = problems.filter(p => p.severity === 'error').length;
    renderAst(t, errors ? 'The program has errors: this tree is what the parser could recover, and may be incomplete.' : '');
    chip($('ast-chip'), errors ? 'error' : 'ok', errors ? `${t.name} · partial` : t.name);
}

// ---------------------------------------------------------------- syntax tree

interface Region { offset: number; end: number }
const isRef = (v: any) => v && typeof v === 'object' && ('$ref' in v || '$error' in v) && !('$type' in v);
const isNode = (v: any) => v && typeof v === 'object' && !Array.isArray(v) && !isRef(v);

function countNodes(v: any): number {
    if (Array.isArray(v)) return v.reduce((n, x) => n + countNodes(x), 0);
    if (!isNode(v)) return 0;
    return 1 + Object.entries(v).reduce((n, [k, x]) => n + (k.startsWith('$') ? 0 : countNodes(x)), 0);
}

function renderAst(t: Tab, banner: string) {
    const host = $('ast');
    host.replaceChildren();
    if (astView === 'output') { renderOutput(t, host, banner); return; }
    if (banner) host.append(el('div', 'banner', banner));
    if (!t.result) return;
    const root = JSON.parse(t.result.ast);
    if (astView === 'json') {
        host.append(el('pre', '', JSON.stringify(root, (k, v) => k === '$textRegion' ? undefined : v, 2)));
        return;
    }
    const openDepth = countNodes(root) > 1500 ? 2 : Infinity;
    host.append(renderValue(t, '', root, '', 0, openDepth, root.$textRegion));
    if (programView.hasFocus) syncCursor();
}

/** What the generator made of this program: the files it wrote, what it returned, what it printed. */
function outputText(t: Tab): string {
    const o = t.result?.output;
    if (!o) return '';
    return [...o.files.map(f => `// ${f.path}\n${f.content}`), o.result ?? '', o.console.join('\n')].filter(Boolean).join('\n\n');
}

function renderOutput(t: Tab, host: HTMLElement, staleBanner: string) {
    const r = t.result;
    const stale = host.classList.contains('stale');
    if (stale && staleBanner) host.append(el('div', 'banner', staleBanner.replace('tree', 'output')));
    if (!r) return;
    const note = (text: string) => host.append(el('div', 'note', text));
    const block = (title: string, text: string) => {
        const box = el('div', 'file');
        box.append(el('div', 'file-name', title), el('pre', '', text));
        host.append(box);
    };
    if (r.generated === 'none') { note(codeAllowed ? 'No generator. Write one in the "Generator" tab, on the left: a function that receives the AST of the program and returns a text, or writes files.' : 'The generator of this shared link has not been run.'); return; }

    // There is a generator: a button to run it now, and a tick to stop running it at every change.
    const bar = el('div', 'runbar');
    const runButton = el('button', 'primary', '▶ Run');
    runButton.title = 'Run the generator on this program now';
    runButton.onclick = () => { t.runOnce = true; t.dirty = true; schedule(0); };
    const tick = document.createElement('input');
    tick.type = 'checkbox'; tick.checked = autoRun;
    tick.onchange = () => {
        autoRun = tick.checked;
        try { localStorage.setItem(AUTO_RUN_KEY, autoRun ? 'on' : 'off'); } catch { /* private mode */ }
        if (autoRun) { for (const x of tabs) x.dirty = true; schedule(0); }
    };
    const label = el('label');
    label.append(tick, ' Run automatically at every change');
    bar.append(runButton, label);
    host.append(bar);

    if (r.generated === 'skipped') { note('The program has errors: the generator was not run.'); return; }
    if (r.generated === 'paused') { note('The generator has not been run on this version of the program: press "Run".'); return; }
    if (r.generated === 'failed') host.append(el('div', 'banner', `The generator failed: ${r.generatorProblems[0]?.message ?? 'unknown error'} (generator, line ${r.generatorProblems[0]?.line ?? '?'})`));
    const o = r.output;
    if (!o) return;
    for (const f of o.files) block(f.path, f.content);
    if (o.result !== undefined) block(o.files.length ? 'returned value' : 'result', o.result);
    if (o.console.length) block('console', o.console.join('\n'));
    if (r.generated === 'ok' && !o.files.length && o.result === undefined && !o.console.length) note('The generator returned nothing, wrote no file and printed nothing.');
}

function mark(e: HTMLElement, region?: Region) {
    if (region && region.end > region.offset) { e.dataset.from = String(region.offset); e.dataset.to = String(region.end); }
}

function keyLabel(key: string) { return key === '' ? [] : [el('span', 'key', key), el('span', 'dim', ': ')]; }

function renderValue(t: Tab, key: string, value: any, path: string, depth: number, openDepth: number, region?: Region): HTMLElement {
    if (Array.isArray(value) || isNode(value)) {
        const details = document.createElement('details');
        const summary = el('summary');
        summary.append(...keyLabel(key));
        let children: () => HTMLElement[];
        if (Array.isArray(value)) {
            summary.append(el('span', 'dim', `[${value.length}]`));
            children = () => value.map((v, i) => renderValue(t, String(i), v, `${path}/${i}`, depth + 1, openDepth, isNode(v) ? v.$textRegion : (region as any)?.[i]));
        } else {
            summary.append(el('span', 'type', value.$type ?? '?'));
            const assigned = value.$textRegion?.assignments ?? {};
            children = () => Object.entries(value).filter(([k]) => !k.startsWith('$')).map(([k, v]) =>
                renderValue(t, k, v, `${path}/${k}`, depth + 1, openDepth, isNode(v) ? (v as any).$textRegion : Array.isArray(v) ? assigned[k] : assigned[k]?.[0]));
            mark(summary, value.$textRegion);
        }
        const kids = el('div', 'kids');
        let filled = false;
        const fill = () => { if (!filled) { filled = true; kids.append(...children()); } };
        details.open = t.open.get(path) ?? depth < openDepth;
        if (details.open) fill();
        details.addEventListener('toggle', () => { t.open.set(path, details.open); if (details.open) fill(); });
        details.append(summary, kids);
        return details;
    }
    const leaf = el('div', 'leaf');
    leaf.append(...keyLabel(key));
    if (isRef(value)) {
        if ('$error' in value) leaf.append(el('span', 'bad', `unresolved reference${value.$refText ? ` '${value.$refText}'` : ''}`));
        else leaf.append(el('span', 'ref', `→ ${value.$refText ?? value.$ref}`), el('span', 'dim', '  reference'));
    } else {
        leaf.append(el('span', typeof value === 'string' ? 'str' : typeof value === 'number' ? 'num' : 'bool', JSON.stringify(value)));
    }
    mark(leaf, region);
    return leaf;
}

/** Tree -> editor: hovering a node shows its text, clicking selects it. */
function regionOf(target: EventTarget | null): { from: number; to: number } | null {
    const e = (target as HTMLElement | null)?.closest?.('[data-from]') as HTMLElement | null;
    return e && fresh(tab()) ? { from: Number(e.dataset.from), to: Number(e.dataset.to) } : null;
}
$('ast').addEventListener('mouseover', e => programView.dispatch({ effects: setHighlight.of(regionOf(e.target)) }));
$('ast').addEventListener('mouseleave', () => programView.dispatch({ effects: setHighlight.of(null) }));
$('ast').addEventListener('click', e => {
    const r = regionOf(e.target);
    if (!r || (e.target as HTMLElement).closest('summary') && (e as MouseEvent).detail === 0) return;
    programView.dispatch({ selection: { anchor: r.from, head: r.to }, scrollIntoView: true });
});

/** Editor -> tree: the innermost visible node around the cursor is marked. */
function syncCursor() {
    const host = $('ast');
    host.querySelector('.at-cursor')?.classList.remove('at-cursor');
    if (astView !== 'tree' || !fresh(tab())) return;
    const pos = programView.state.selection.main.head;
    let best: HTMLElement | null = null, size = Infinity;
    for (const e of host.querySelectorAll<HTMLElement>('[data-from]')) {
        const from = Number(e.dataset.from), to = Number(e.dataset.to);
        if (from <= pos && pos <= to && to - from <= size && e.offsetParent) { best = e; size = to - from; }
    }
    if (best) { best.classList.add('at-cursor'); best.scrollIntoView({ block: 'nearest' }); }
}

// ---------------------------------------------------------------- saving, sharing, examples

/** g: grammar, v: validator, x: generator, p: programs, a: active program, c: false = code not yet agreed to. */
interface Saved { g: string; v?: string; x?: string; p: { n: string; t: string }[]; a: number; c?: boolean }
const KEY = 'langium-playground-standalone:v1';

const snapshot = (): Saved => ({
    g: grammarView.state.doc.toString(), v: codeOf('validator'), x: codeOf('generator'),
    p: tabs.map(t => ({ n: t.name, t: textOf(t) })), a: active, ...(codeAllowed ? {} : { c: false }),
});
const fromExample = (ex: (typeof EXAMPLES)[number]): Saved =>
    ({ g: ex.grammar, v: ex.validator ?? '', x: ex.generator ?? '', p: ex.programs.map(p => ({ n: p.name, t: p.text })), a: 0 });

function save() {
    try { localStorage.setItem(KEY, JSON.stringify(snapshot())); } catch { /* private mode: nothing to do */ }
}

/** True after loading an example or a new language: its empty code tabs get a starting file. */
let wantStarters = false;

function load(s: Saved, starters = false) {
    wantStarters = starters && s.c !== false;
    tabs = (s.p?.length ? s.p : [{ n: 'program-1', t: '' }]).map(p => newTab(String(p.n), String(p.t)));
    active = Math.min(Math.max(0, s.a | 0), tabs.length - 1);
    grammar.result = undefined;
    shown = undefined;
    codeAllowed = s.c !== false;
    $('consent').hidden = codeAllowed;
    for (const [side, text] of [['grammar', s.g], ['validator', s.v], ['generator', s.x]] as const) {
        const view = leftViews[side];
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(text ?? '') } });
    }
    grammar.rev++; grammar.dirty = true;
    programView.setState(tab().state);
    $('ast').replaceChildren(); $('program-problems').replaceChildren(); $('grammar-problems').replaceChildren();
    chip($('ast-chip'), '', ''); chip($('grammar-chip'), '', 'analysing…');
    renderTabs();
    schedule(0);
}

/** Replaces the work on screen, and offers to bring it back. */
function replaceWith(s: Saved, what: string, starters = false) {
    const before = snapshot();
    const hadWork = before.g.trim() !== '' && JSON.stringify(before) !== JSON.stringify(s);
    load(s, starters);
    toast(what, hadWork ? { label: 'Undo', run: () => load(before) } : undefined);
}

let toastTimer = 0;
function toast(text: string, action?: { label: string; run: () => void }) {
    const host = $('toast');
    host.replaceChildren(el('span', '', text));
    if (action) {
        const b = el('button', '', action.label);
        b.onclick = () => { host.hidden = true; action.run(); };
        host.append(b);
    }
    host.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { host.hidden = true; }, action ? 12_000 : 3_000);
}

async function pack(s: Saved): Promise<string> {
    const stream = new Blob([JSON.stringify(s)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function unpack(code: string): Promise<Saved> {
    const bin = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return JSON.parse(await new Response(stream).text());
}

function download(name: string, text: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('version').textContent = __LANGIUM_VERSION__;
for (const [i, ex] of EXAMPLES.entries()) $('examples').append(new Option(ex.name, String(i)));
$<HTMLSelectElement>('examples').onchange = e => {
    const select = e.target as HTMLSelectElement;
    const ex = EXAMPLES[Number(select.value)];
    select.value = '';
    if (ex) replaceWith(fromExample(ex), `Example "${ex.name}" loaded.`, true);
};
// A new language: a small grammar that works, a program, and a validator and a generator to fill.
$('new').onclick = () => {
    const asked = prompt('Name of the new language (one word, for instance Robots):', 'MyDsl');
    if (asked == null) return;
    const lang = newLanguage(asked);
    replaceWith({ g: lang.grammar, v: '', x: '', p: [{ n: lang.program.name, t: lang.program.text }], a: 0 }, `New language "${lang.name}". Your previous work can be brought back.`, true);
    selectLeft('grammar');
};
for (const side of LEFT) {
    const b = document.querySelector<HTMLElement>(`[data-left="${side}"]`)!;
    b.onclick = () => selectLeft(side);
    b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLeft(side); } };
}
// Code that came with a share link runs only once the reader has agreed.
$('consent-run').onclick = () => {
    codeAllowed = true;
    grammar.rev++; grammar.dirty = true;
    renderGrammar();
    schedule(0);
};
$('add-tab').onclick = () => {
    let n = tabs.length + 1;
    while (tabs.some(t => t.name === `program-${n}`)) n++;
    tabs.push(newTab(`program-${n}`, ''));
    select(tabs.length - 1);
    schedule(0);
};
$('download-grammar').onclick = () => download(left === 'grammar' ? `${grammar.result?.name || 'grammar'}.langium` : `${left}.ts`, leftViews[left].state.doc.toString());$('download-program').onclick = () => download(/\.\w+$/.test(tab().name) ? tab().name : `${tab().name}.txt`, textOf(tab()));
$('share').onclick = async () => {
    const url = `${location.href.split('#')[0]}#s=${await pack(snapshot())}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied. It contains the grammar, the validator, the generator and the programs.'); }
    catch { prompt('Copy this link', url); }
};
$('format').onclick = () => formatText(grammarView, 'grammar');
$('copy-json').onclick = async () => {
    const t = tab();
    if (!t.result || !fresh(t)) return;
    const text = astView === 'output' ? outputText(t) : JSON.stringify(JSON.parse(t.result.ast), (k, v) => k === '$textRegion' ? undefined : v, 2);
    try { await navigator.clipboard.writeText(text); toast(astView === 'output' ? 'Output copied.' : 'AST copied as JSON.'); } catch { toast('The browser refused to copy.'); }
};
const VIEWS = ['tree', 'json', 'output'] as const;
for (const view of VIEWS) {
    $(`view-${view}`).onclick = () => {
        astView = view;
        for (const v of VIEWS) $(`view-${v}`).setAttribute('aria-pressed', String(v === view));
        renderProgram();
    };
}

// Column widths: drag the gaps between the panels.
const widths = [1, 1, 0.8];
for (const handle of document.querySelectorAll<HTMLElement>('.split')) {
    const i = Number(handle.dataset.split);
    handle.onpointerdown = down => {
        handle.setPointerCapture(down.pointerId);
        handle.classList.add('dragging');
        const total = $('cols').clientWidth, sum = widths[0] + widths[1] + widths[2];
        const a = widths[i], b = widths[i + 1], x = down.clientX;
        handle.onpointermove = move => {
            const d = (move.clientX - x) / total * sum;
            const min = 0.15 * sum / 3;
            if (a + d < min || b - d < min) return;
            widths[i] = a + d; widths[i + 1] = b - d;
            widths.forEach((w, k) => $('cols').style.setProperty(`--c${k}`, `${w}fr`));
        };
        handle.onpointerup = () => { handle.onpointermove = null; handle.classList.remove('dragging'); };
    };
}

// Start: a shared link wins over what this browser remembers, which wins over the first example.
(async () => {
    let stored: Saved | undefined;
    try { stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined; } catch { /* ignore */ }
    load(stored?.g != null ? stored : fromExample(EXAMPLES[0]));
    const shared = /^#s=(.+)$/.exec(location.hash)?.[1];
    if (shared) {
        history.replaceState(null, '', location.pathname + location.search);
        try {
            const s = await unpack(shared);
            // Whatever the link says, its code is not run before the reader agrees.
            const hasCode = !!(String(s.v ?? '').trim() || String(s.x ?? '').trim());
            if (hasCode) s.c = false; else delete s.c;
            replaceWith(s, hasCode ? 'Shared work loaded. Its code has not been run.' : 'Shared grammar and programs loaded.');
        } catch { toast('This share link could not be read.'); }
    }
})();
