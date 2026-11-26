// Checks the built page without a browser: dist/index.html is well formed, and the worker code
// embedded in it (Langium bundled for the browser) answers requests.
//   npm run build && node test/bundle.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('dist/index.html', 'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 2, 'exactly two script elements: the worker source and the page');
assert.match(scripts[0][1], /id="worker-source"/);
assert.equal(/<link|src=|https?:\/\/(?!chevrotain\.io|en\.wikipedia\.org|langium\.org|github\.com|www\.w3\.org)[^"'\s]*\.(js|css)/.test(html.replace(scripts[0][2], '').replace(scripts[1][2], '')), false, 'no external resource');
for (const [, , code] of scripts) new vm.Script(code);       // both parse as JavaScript
console.log('  ok 1 dist/index.html: two inline scripts that parse, no external resource');

// Run the worker source with a minimal stand-in for the worker global scope.
const answers = new Map();
const self = { postMessage: m => answers.get(m.id)?.(m), onmessage: null };
const context = vm.createContext({ self, console, performance, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, queueMicrotask });
new vm.Script(scripts[0][2]).runInContext(context);
let id = 0;
const call = (type, text, offset, extra = {}) => new Promise(resolve => {
    answers.set(++id, resolve);
    self.onmessage({ data: { id, type, text, offset, ...extra } });
});

const grammar = `grammar HelloWorld
entry Model: (persons+=Person | greetings+=Greeting)*;
Person: 'person' name=ID;
Greeting: 'Hello' person=[Person:ID] '!';
hidden terminal WS: /\\s+/;
terminal ID: /[_a-zA-Z][\\w_]*/;
`;
const g = await call('grammar', grammar);
assert.equal(g.ok && g.result.ok, true, JSON.stringify(g));
const p = await call('program', 'person Alice\nHello Alice !\nHello Bob !\n');
assert.equal(p.ok, true, JSON.stringify(p));
assert.equal(JSON.parse(p.result.ast).greetings[0].person.$refText, 'Alice');
assert.match(p.result.problems[0].message, /named 'Bob'/);
assert.deepEqual([p.result.problems[0].line, p.result.problems[0].col], [3, 7]);
const c = await call('complete', 'person Alice\nHello ', 19);
assert.equal(c.result.map(x => x.label).join(), 'Alice');     // (arrays come from another realm)
// Editor features, on the program and on the grammar.
const program = 'person Alice\nHello Alice !\n';
const def = await call('definition', program, 20, { target: 'program' });
assert.equal(`${def.result.from}-${def.result.to}`, '7-12');
const renamed = await call('rename', program, 20, { target: 'program', name: 'Bob' });
assert.equal(renamed.result.map(e => `${e.from}:${e.insert}`).sort().join(), '19:Bob,7:Bob');
const rule = await call('definition', grammar, grammar.indexOf('+=Person') + 3, { target: 'grammar' });
assert.equal(rule.result.from, grammar.indexOf('Person:'));
const formatted = await call('format', grammar.replace('entry Model: ', 'entry    Model:'), 0, { target: 'grammar' });
assert.ok(formatted.result.length > 0);

// User code: a validator and a generator in TypeScript, erased and run inside the worker.
const validator = `import type { ValidationAcceptor } from 'langium';
export function registerValidationChecks(services: any) {
    services.validation.ValidationRegistry.register({ Person: services.validation.HelloWorldValidator.check }, services.validation.HelloWorldValidator);
}
export class HelloWorldValidator {
    check(person: { name: string }, accept: ValidationAcceptor): void {
        if (person.name === 'Bob') accept('warning', 'Not Bob again.', { node: person as any, property: 'name' });
    }
}`;
const generator = `import { isGreeting } from './generated/ast.js';
import { AstUtils } from 'langium';
export function generate(model: any): string {
    return AstUtils.streamAllContents(model).filter(isGreeting).map(g => 'Hello, ' + g.person.ref?.name).join(';');
}`;
const withCode = await call('grammar', grammar, 0, { validator, generator });
assert.equal(withCode.result.ok && withCode.result.validator.length === 0 && withCode.result.generator.length === 0, true, JSON.stringify(withCode));
const run = await call('program', 'person Bob\nperson Alice\nHello Alice !\nHello Bob !\n', 0, { name: 'x.hello' });
assert.equal(run.result.problems.map(x => `${x.line}:${x.col} ${x.severity} ${x.message}`).join(), '1:8 warning Not Bob again.');
assert.equal(run.result.generated, 'ok');
assert.equal(run.result.output.result, 'Hello, Alice;Hello, Bob');
const broken = await call('grammar', grammar, 0, { validator: 'export function registerValidationChecks( {' });
assert.equal(broken.result.ok, false);
assert.equal(broken.result.validator[0].line, 1);
const thrown = await call('grammar', grammar, 0, { generator: 'export function generate(m: any) {\n    return m.nothing.here;\n}' });
const failed = await call('program', 'person Alice\n');
assert.equal(`${failed.result.generated} line ${failed.result.generatorProblems[0].line}`, 'failed line 2', JSON.stringify(failed.result.generatorProblems));
console.log('  ok 3 embedded worker: TypeScript validator and generator run, errors in them are located');

const bad = await call('grammar', grammar.replace('name=ID', 'name=IDD'));
assert.equal(bad.result.ok, false);
const refused = await call('program', 'person Alice\n');
assert.equal(refused.ok, false);
console.log('  ok 2 embedded worker: grammar, program, completion, definition, rename, format, and refusal after a broken grammar');
console.log('bundle test passed');
