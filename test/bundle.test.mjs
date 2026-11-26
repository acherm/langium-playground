// Checks the built page without a browser: dist/index.html is well formed, and the worker code
// embedded in it (Langium bundled for the browser) answers requests.
//   npm run build && node test/bundle.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('dist/index.html', 'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
assert.deepEqual(scripts.map(s => /id="([\w-]+)"/.exec(s[1])?.[1] ?? 'page'), ['worker-source', 'ts-worker-source', 'ts-libs', 'page']);
const outside = scripts.reduce((rest, s) => rest.replace(s[2], ''), html);
assert.equal(/<link|src=|https?:\/\/[^"'\s]*\.(js|css)/.test(outside), false, 'no external resource');
for (const s of [scripts[0], scripts[1], scripts[3]]) new vm.Script(s[2]);       // the three programs parse as JavaScript
const libs = JSON.parse(scripts[2][2]);
assert.ok(libs['/lib/lib.es5.d.ts'] && libs['/node_modules/langium/package.json']);
console.log('  ok 1 dist/index.html: page, two workers and the type declarations, all inline; no external resource');

// The TypeScript worker, with only what a browser worker has (no `process`, no `require`).
{
    const answers = new Map();
    const self = { postMessage: m => answers.get(m.id)?.(m), onmessage: null };
    new vm.Script(scripts[1][2]).runInContext(vm.createContext({ self, console, performance, setTimeout, clearTimeout, TextEncoder, TextDecoder }));
    let id = 0;
    const call = (type, extra = {}) => new Promise(resolve => { answers.set(++id, resolve); self.onmessage({ data: { id, type, ...extra } }); });
    const init = await call('init', { libs });
    assert.equal(init.ok, true, JSON.stringify(init));
    const ast = `import * as langium from 'langium';
export interface Person extends langium.AstNode { readonly $type: 'Person'; name: string; }
export type HelloAstType = { Person: Person }
export declare const reflection: langium.AstReflection;`;
    const validator = `import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { HelloAstType, Person } from './generated/ast.js';
import type { HelloServices } from './hello-module.js';
export function registerValidationChecks(services: HelloServices) {
    const checks: ValidationChecks<HelloAstType> = { Person: services.validation.HelloValidator.check };
    services.validation.ValidationRegistry.register(checks, services.validation.HelloValidator);
}
export class HelloValidator {
    check(person: Person, accept: ValidationAcceptor): void {
        if (person.nam) accept('warning', 'x', { node: person, property: 'name' });
    }
}`;
    const sources = { validator, generator: '', ast, name: 'Hello' };
    const d = await call('diagnostics', { sources });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.result.validator.map(p => `${p.line}: ${p.message}`).join(), "10: Property 'nam' does not exist on type 'Person'. Did you mean 'name'?");
    const c = await call('complete', { sources, file: 'validator', offset: validator.indexOf('person.nam') + 7 });
    assert.ok(c.result.items.some(i => i.label === 'name') && c.result.items.some(i => i.label === '$container'));
    const h = await call('hover', { sources, file: 'validator', offset: validator.indexOf("accept('warning'") + 2 });
    assert.match(h.result, /^\(parameter\) accept: .*ValidationSeverity/);
    console.log(`  ok 2 embedded TypeScript worker: starts without Node, type-checks against Langium, completes, hovers (${d.ms.toFixed(0)} ms for the first check)`);
}

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
console.log('  ok 3 embedded Langium worker: TypeScript validator and generator run, errors in them are located');

const bad = await call('grammar', grammar.replace('name=ID', 'name=IDD'));
assert.equal(bad.result.ok, false);
const refused = await call('program', 'person Alice\n');
assert.equal(refused.ok, false);
console.log('  ok 4 embedded Langium worker: grammar, program, completion, definition, rename, format, and refusal after a broken grammar');
console.log('bundle test passed');
