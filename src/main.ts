// The page: two editors, their problem lists and the syntax tree. Langium itself runs in a worker
// (src/worker.ts). Three rules keep the display honest:
//   1. one analysis at a time, and a result is shown only if the text it was computed from is
//      still the text in the editor (no stale AST);
//   2. an analysis that takes too long is abandoned and the worker replaced (no frozen page);
//   3. when the grammar is invalid, programs are not analysed and the page says so.
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState, StateEffect, StateField, type Extension, type TransactionSpec } from '@codemirror/state';
import { Decoration, type DecorationSet, hoverTooltip, keymap } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { EditorView, basicSetup } from 'codemirror';
import type { Completion, GrammarResult, Problem, ProgramResult, Token } from './analysis';
import { EXAMPLES } from './examples';

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
    private readonly url = URL.createObjectURL(new Blob([$('worker-source').textContent ?? ''], { type: 'text/javascript' }));
    lastMs = 0;

    constructor() { this.start(); }

    private start() {
        this.worker = new Worker(this.url);
        this.worker.onmessage = e => {
            const p = this.pending.get(e.data.id);
            if (!p) return;
            this.pending.delete(e.data.id);
            clearTimeout(p.timer);
            if (e.data.ok) { this.lastMs = e.data.ms; p.resolve(e.data.result); } else p.reject(new Error(e.data.error));
        };
        this.worker.onerror = e => this.restart(new Error(e.message || 'The analyser crashed.'));
    }

    /** Number of times the worker was replaced: a new worker has no grammar yet. */
    restarts = 0;

    private restart(reason: Error) {
        this.restarts++;
        this.worker.terminate();
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
        this.pending.clear();
        this.start();
    }

    /** An analysis that times out costs the worker its life; a completion that times out is just dropped. */
    call<T>(type: 'grammar' | 'program' | 'complete', text: string, timeout: number, offset?: number): Promise<T> {
        const id = ++this.seq;
        return new Promise<T>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                if (type !== 'complete') return this.restart(new TimeoutError());
                this.pending.delete(id);
                reject(new TimeoutError());
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({ id, type, text, offset });
        });
    }
}

const engine = new Engine();

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
}

const grammar = { rev: 0, dirty: true, result: undefined as GrammarResult | undefined, resultRev: -1, failure: '' };
let tabs: Tab[] = [];
let active = 0;
let astView: 'tree' | 'json' = 'tree';
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

async function completions(ctx: CompletionContext): Promise<CompletionResult | null> {
    if (!grammar.result?.ok || grammar.resultRev !== grammar.rev) return null;
    const word = ctx.matchBefore(/[\w-]+/);
    if (!ctx.explicit && !word) return null;
    let items: Completion[] = [];
    try { items = await engine.call<Completion[]>('complete', ctx.state.doc.toString(), 3000, ctx.pos); } catch { return null; }
    if (ctx.aborted || !items.length) return null;
    return {
        from: Math.min(ctx.pos, ...items.map(i => i.from)),
        validFor: /^[\w-]*$/,
        options: items.map(i => ({ label: i.label, detail: i.detail, type: i.kind === 'keyword' ? 'keyword' : i.kind === 'reference' ? 'variable' : 'text', apply: i.insert })),
    };
}

const common: Extension = [basicSetup, keymap.of([indentWithTab]), EditorView.lineWrapping, syntaxHighlighting(classHighlighter)];

const grammarView = new EditorView({
    parent: $('grammar-editor'),
    state: EditorState.create({
        extensions: [common, grammarLanguage, EditorView.updateListener.of(u => {
            if (!u.docChanged) return;
            grammar.rev++; grammar.dirty = true;
            schedule(300);
        })],
    }),
});

const programExtensions: Extension = [common, tokenField, highlightField, tokenTooltip, autocompletion({ override: [completions] }),
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
                    result = await engine.call<GrammarResult>('grammar', grammarView.state.doc.toString(), GRAMMAR_TIMEOUT);
                    builtIn = engine.restarts;
                } catch (e) {
                    failure = e instanceof TimeoutError
                        ? `The grammar could not be analysed in ${GRAMMAR_TIMEOUT / 1000} s. The analyser was restarted; edit the grammar to try again.`
                        : `The analyser failed on this grammar: ${(e as Error).message}`;
                }
                if (rev !== grammar.rev) continue;          // edited meanwhile: this result is stale
                grammar.result = result; grammar.resultRev = rev; grammar.failure = failure;
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
                const result = await engine.call<ProgramResult>('program', textOf(t), PROGRAM_TIMEOUT);
                if (!tabs.includes(t) || rev !== t.rev || grev !== grammar.rev) continue;
                t.result = result; t.resultRev = rev; t.resultGrammarRev = grev; t.failure = undefined; t.failedKey = undefined;
                apply(t, { effects: setTokens.of(result.tokens) });
                apply(t, setDiagnostics(t.state, toDiagnostics(result.problems, t.state.doc.length)));
            } catch (e) {
                const timeout = e instanceof TimeoutError;
                if (!tabs.includes(t) || rev !== t.rev || grev !== grammar.rev) continue;
                t.failedKey = key;
                t.failure = timeout
                    ? `This program could not be analysed in ${PROGRAM_TIMEOUT / 1000} s (a terminal regular expression that backtracks a lot, or a loop in the grammar). The analyser was restarted; edit the program or the grammar to try again.`
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

function renderGrammar() {
    if (grammar.resultRev !== grammar.rev) return;
    const problems = grammarProblems();
    const len = grammarView.state.doc.length;
    grammarView.dispatch(setDiagnostics(grammarView.state, toDiagnostics(problems, len)));
    problemList($('grammar-problems'), problems, grammarView, 'No problem in the grammar.', grammar.failure || undefined);
    const errors = problems.filter(p => p.severity === 'error').length, warnings = problems.filter(p => p.severity === 'warning').length;
    const r = grammar.result;
    if (!r) chip($('grammar-chip'), 'error', 'not analysed');
    else if (errors) chip($('grammar-chip'), 'error', count(errors, 'error'));
    else if (warnings) chip($('grammar-chip'), 'warning', `${r.name} · ${count(warnings, 'warning')}`);
    else chip($('grammar-chip'), 'ok', `✓ ${r.name} · ${count(r.rules, 'rule')}`);
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
        problemList(host, [], programView, '', 'The grammar has errors: programs are not analysed until it is fixed.');
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

interface Saved { g: string; p: { n: string; t: string }[]; a: number }
const KEY = 'langium-playground-standalone:v1';

const snapshot = (): Saved => ({ g: grammarView.state.doc.toString(), p: tabs.map(t => ({ n: t.name, t: textOf(t) })), a: active });

function save() {
    try { localStorage.setItem(KEY, JSON.stringify(snapshot())); } catch { /* private mode: nothing to do */ }
}

function load(s: Saved) {
    tabs = (s.p?.length ? s.p : [{ n: 'program-1', t: '' }]).map(p => newTab(String(p.n), String(p.t)));
    active = Math.min(Math.max(0, s.a | 0), tabs.length - 1);
    grammar.result = undefined;
    shown = undefined;
    grammarView.dispatch({ changes: { from: 0, to: grammarView.state.doc.length, insert: String(s.g ?? '') } });
    grammar.rev++; grammar.dirty = true;
    programView.setState(tab().state);
    $('ast').replaceChildren(); $('program-problems').replaceChildren(); $('grammar-problems').replaceChildren();
    chip($('ast-chip'), '', ''); chip($('grammar-chip'), '', 'analysing…');
    renderTabs();
    schedule(0);
}

/** Replaces the work on screen, and offers to bring it back. */
function replaceWith(s: Saved, what: string) {
    const before = snapshot();
    const hadWork = before.g.trim() !== '' && JSON.stringify(before) !== JSON.stringify(s);
    load(s);
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
    if (ex) replaceWith({ g: ex.grammar, p: ex.programs.map(p => ({ n: p.name, t: p.text })), a: 0 }, `Example "${ex.name}" loaded.`);
};
$('add-tab').onclick = () => {
    let n = tabs.length + 1;
    while (tabs.some(t => t.name === `program-${n}`)) n++;
    tabs.push(newTab(`program-${n}`, ''));
    select(tabs.length - 1);
    schedule(0);
};
$('download-grammar').onclick = () => download(`${grammar.result?.name || 'grammar'}.langium`, grammarView.state.doc.toString());
$('download-program').onclick = () => download(/\.\w+$/.test(tab().name) ? tab().name : `${tab().name}.txt`, textOf(tab()));
$('share').onclick = async () => {
    const url = `${location.href.split('#')[0]}#s=${await pack(snapshot())}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied. It contains the grammar and the programs.'); }
    catch { prompt('Copy this link', url); }
};
$('copy-json').onclick = async () => {
    const t = tab();
    if (!t.result) return;
    const json = JSON.stringify(JSON.parse(t.result.ast), (k, v) => k === '$textRegion' ? undefined : v, 2);
    try { await navigator.clipboard.writeText(json); toast('AST copied as JSON.'); } catch { toast('The browser refused to copy.'); }
};
for (const view of ['tree', 'json'] as const) {
    $(`view-${view}`).onclick = () => {
        astView = view;
        $('view-tree').setAttribute('aria-pressed', String(view === 'tree'));
        $('view-json').setAttribute('aria-pressed', String(view === 'json'));
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
    const first = EXAMPLES[0];
    const fallback: Saved = { g: first.grammar, p: first.programs.map(p => ({ n: p.name, t: p.text })), a: 0 };
    let stored: Saved | undefined;
    try { stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined; } catch { /* ignore */ }
    load(stored?.g != null ? stored : fallback);
    const shared = /^#s=(.+)$/.exec(location.hash)?.[1];
    if (shared) {
        history.replaceState(null, '', location.pathname + location.search);
        try { replaceWith(await unpack(shared), 'Shared grammar and programs loaded.'); }
        catch { toast('This share link could not be read.'); }
    }
})();
