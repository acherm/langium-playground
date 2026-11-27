// The "State machine" example: the grammar and the validator of the Langium examples, unchanged,
// and a generator to an interactive page. The page is checked by running its script against a
// minimal stand-in for a document (plain Node, no browser).
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { analyzeGrammar, analyzeProgram } from '../src/analysis.ts';
import { EXAMPLES } from '../src/examples.ts';
import { createService } from '../src/tsservice.ts';
import { collectDeclarations } from '../tools/dts.mjs';

let n = 0;
const ok = (name: string) => console.log(`  ok ${++n} ${name}`);
const ex = EXAMPLES.find(e => e.name === 'State machine')!;
const messages = (ps: { line: number; message: string }[]) => ps.map(p => `${p.line}: ${p.message}`);

const info = await analyzeGrammar(ex.grammar, ex);
assert.deepEqual([info.ok, info.name, info.entry, info.validator, info.generator], [true, 'StatemachineModel', 'Statemachine', [], []]);
ok('the grammar is accepted, validator and generator load');

// The validator asks for StatemachineAstType and StatemachineServices: names of the project, not of
// the grammar (StatemachineModel). They are accepted.
const service = createService(collectDeclarations());
service.update({ validator: ex.validator!, generator: ex.generator!, ast: info.astSource, name: info.name });
assert.deepEqual(messages(service.diagnostics('validator')), []);
assert.deepEqual(messages(service.diagnostics('generator')), []);
service.update({ validator: ex.validator!.replace('state.name.substring', 'state.nam.substring'), generator: ex.generator!, ast: info.astSource, name: info.name });
assert.match(messages(service.diagnostics('validator'))[0], /Property 'nam' does not exist on type 'State'/);
ok('validator (unchanged) and generator have no type error; a real type error is still found');

const bad = await analyzeProgram('statemachine M\nevents go go\ninitialState a\nstate a go => a end\nstate B end\nstate B end\n');
assert.deepEqual(messages(bad.problems), [
    '2: Duplicate identifier name: go', '2: Duplicate identifier name: go',
    '4: State name should start with a capital letter.',
    '5: Duplicate identifier name: B', '6: Duplicate identifier name: B',
]);
assert.equal(bad.generated, 'skipped');
ok('the checks of the validator: capital letter, duplicate names');

/** Runs the script of a generated page; returns what a user would see and a way to click. */
function open(html: string) {
    const script = /<script>\n([\s\S]*)\n<\/script>/.exec(html)![1];
    const make = (tag: string) => {
        const e: any = { tag, className: '', disabled: false, onclick: null as null | (() => void), children: [] as any[], _text: '' };
        Object.defineProperty(e, 'textContent', { get: () => e._text, set: (v: string) => { e._text = v; if (v === '') e.children = []; } });
        e.appendChild = (c: any) => { e.children.push(c); return c; };
        return e;
    };
    const byId: Record<string, any> = {};
    for (const id of ['states', 'events', 'log', 'actions', 'reset']) { assert.ok(html.includes(`id="${id}"`), id); byId[id] = make('div'); }
    vm.runInNewContext(script, { document: { getElementById: (id: string) => byId[id], createElement: make } });
    return {
        current: () => byId.states.children.filter((c: any) => c.className === 'state current').map((c: any) => c._text).join(),
        states: () => byId.states.children.map((c: any) => c._text),
        enabled: () => byId.events.children.filter((c: any) => !c.disabled).map((c: any) => c._text),
        click: (event: string) => byId.events.children.find((c: any) => c._text === event).onclick(),
        log: () => byId.log.children.map((c: any) => c._text),
        actions: () => byId.actions._text,
        reset: () => byId.reset.onclick(),
    };
}

const light = await analyzeProgram(ex.programs[0].text, ex.programs[0].name);
assert.deepEqual([light.problems, light.generated, light.output!.files.map(f => f.path)], [[], 'ok', ['generated/trafficlight.html']]);
const page = open(light.output!.files[0].content);
assert.deepEqual(page.states(), ['PowerOff', 'RedLight', 'YellowLight', 'GreenLight']);
assert.deepEqual([page.current(), page.enabled()], ['PowerOff', ['switchCapacity']]);       // `next` is not possible when off
page.click('switchCapacity');
assert.deepEqual([page.current(), page.enabled()], ['RedLight', ['switchCapacity', 'next']]);
page.click('next'); page.click('next'); page.click('next');
assert.equal(page.current(), 'RedLight');                                                   // red, green, yellow, red
assert.equal(page.log().length, 4);
assert.equal(page.log()[1], 'RedLight — next → GreenLight');
page.reset();
assert.deepEqual([page.current(), page.log()], ['PowerOff', []]);
ok('traffic light: the generated page runs the machine (states, enabled events, steps, reset)');

const turnstile = await analyzeProgram(ex.programs[1].text, ex.programs[1].name);
assert.deepEqual([turnstile.problems, turnstile.generated], [[], 'ok']);
const gate = open(turnstile.output!.files[0].content);
assert.deepEqual([gate.current(), gate.actions(), gate.enabled()], ['Locked', 'actions: lock', ['coin']]);
gate.click('coin'); gate.click('coin');
assert.deepEqual([gate.current(), gate.actions(), gate.enabled()], ['Refunding', 'actions: refund', ['push']]);
ok('turnstile: commands are shown as the actions of the current state');

// A name can hold no markup (it is an ID), and the data cannot close the script element.
assert.equal(/<\/script>[\s\S]*<\/script>/.test(light.output!.files[0].content), false);
ok('the page has a single script element');
console.log(`state machine tests passed (${n})`);
