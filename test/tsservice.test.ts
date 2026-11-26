// Tests of the TypeScript service for the validator and the generator (src/tsservice.ts): plain Node.
import assert from 'node:assert/strict';
import { analyzeGrammar } from '../src/analysis.ts';
import { EXAMPLES } from '../src/examples.ts';
import { createService, type Sources } from '../src/tsservice.ts';
import { collectDeclarations } from '../tools/dts.mjs';

let n = 0;
async function test(name: string, fn: () => Promise<void> | void) {
    await fn();
    console.log(`  ok ${++n} ${name}`);
}
const started = performance.now();
const service = createService(collectDeclarations());
const hello = EXAMPLES.find(e => e.name === 'Hello world')!;
const chuno = EXAMPLES.find(e => e.name === 'Chess-Uno')!;

async function sourcesOf(ex: typeof hello, changes: Partial<Sources> = {}): Promise<Sources> {
    const g = await analyzeGrammar(ex.grammar);
    assert.ok(g.astSource.includes(`export type ${g.name}AstType`), 'the AST types are produced');
    return { validator: ex.validator ?? '', generator: ex.generator ?? '', ast: g.astSource, name: g.name, ...changes };
}
const after = (text: string, needle: string) => { const i = text.indexOf(needle); assert.ok(i >= 0, needle); return i + needle.length; };
const messages = (ps: { line: number; message: string }[]) => ps.map(p => `${p.line}: ${p.message}`);

await test('the AST types are those of a generated ast.ts: interfaces, guards, constants, the AstType map', async () => {
    const g = await analyzeGrammar(chuno.grammar);
    assert.match(g.astSource, /export interface Card extends langium\.AstNode \{\n    readonly \$container: Game;\n    readonly \$type: 'Card';\n    effect: Effect;\n    name: string;\n\}/);
    assert.match(g.astSource, /export function isMove\(item: unknown\): item is Move/);
    assert.match(g.astSource, /export type Effect = Drop \| Move \| Pass \| Swap;/);
    assert.match(g.astSource, /export type MiniChunoAstType = \{\n    Card: Card\n    Deck: Deck/);
    assert.deepEqual(g.types.map(t => t.name), ['Game', 'Deck', 'DeckEntry', 'Card', 'Move', 'Pass', 'Swap', 'Drop']);
    assert.deepEqual(g.types[0].properties.find(p => p.name === 'cards'), { name: 'cards', array: true, optional: false });
});

await test('the files of the Langium template, unchanged, have no type error', async () => {
    service.update(await sourcesOf(hello));
    assert.deepEqual(messages(service.diagnostics('validator')), []);
    assert.deepEqual(messages(service.diagnostics('generator')), []);
});

await test('the files of MiniChuno, unchanged, have no type error', async () => {
    service.update(await sourcesOf(chuno));
    assert.deepEqual(messages(service.diagnostics('validator')), []);
    assert.deepEqual(messages(service.diagnostics('generator')), []);
});

await test('type errors are found and located: unknown property, wrong severity, unknown AST type', async () => {
    const validator = hello.validator!
        .replace('if (person.name) {', 'if (person.nam) {')
        .replace("accept('warning',", "accept('warnin',");
    service.update(await sourcesOf(hello, { validator, generator: hello.generator!.replace('model.greetings', 'model.greetingz') }));
    const v = service.diagnostics('validator');
    assert.deepEqual(messages(v), [
        "23: Property 'nam' does not exist on type 'Person'. Did you mean 'name'?",
        `26: Argument of type '"warnin"' is not assignable to parameter of type 'ValidationSeverity'.`,
    ]);
    assert.equal(validator.slice(v[0].from, v[0].to), 'nam');
    assert.match(messages(service.diagnostics('generator'))[0], /^13: Property 'greetingz' does not exist on type 'Model'/);
    service.update(await sourcesOf(hello, { validator: hello.validator!.replace('HelloWorldAstType, Person }', 'HelloWorldAstType, Animal }') }));
    assert.match(messages(service.diagnostics('validator'))[0], /^2: Module '".*ast.*"' has no exported member 'Animal'/);
});

await test('a syntax error is reported too, and an empty file has no problem', async () => {
    service.update(await sourcesOf(hello, { validator: 'export function f( {\n', generator: '  \n' }));
    assert.ok(service.diagnostics('validator').length >= 1);
    assert.deepEqual(service.diagnostics('generator'), []);
});

await test('completion: the properties of an AST node, with the types of the grammar', async () => {
    const validator = hello.validator!.replace('if (person.name) {', 'person.\n        if (person.name) {');
    service.update(await sourcesOf(hello, { validator }));
    const c = service.complete('validator', after(validator, 'person.'));
    const labels = c.items.map(i => i.label);
    assert.ok(labels.includes('name') && labels.includes('$container') && labels.includes('$cstNode'), labels.join());
    assert.equal(labels.includes('greetings'), false);
    assert.deepEqual(c.items.find(i => i.label === 'name'), { label: 'name', kind: 'property', detail: 'property' });
});

await test('completion: the services of the language, the validator class included', async () => {
    const validator = hello.validator!.replace('const validator = services.validation.HelloWorldValidator;', 'const validator = services.validation.');
    service.update(await sourcesOf(hello, { validator }));
    const labels = service.complete('validator', after(validator, 'const validator = services.validation.')).items.map(i => i.label);
    assert.deepEqual(labels.sort(), ['DocumentValidator', 'HelloWorldValidator', 'ValidationRegistry']);
});

await test('completion: inside a string, the properties that `accept` can point to, and the severities', async () => {
    const validator = hello.validator!.replace("property: 'name'", "property: ''");
    service.update(await sourcesOf(hello, { validator }));
    const c = service.complete('validator', after(validator, "property: '"));
    assert.deepEqual(c.items.map(i => i.label), ['name']);
    const severity = hello.validator!.replace("accept('warning'", "accept(''");
    service.update(await sourcesOf(hello, { validator: severity }));
    assert.deepEqual(service.complete('validator', after(severity, "accept('")).items.map(i => i.label).sort(), ['error', 'hint', 'info', 'warning']);
});

await test('completion: a prefix is replaced from its start, and the generator knows langium/generate', async () => {
    const generator = hello.generator!.replace('fileNode.append(\'"use strict";\', NL, NL);', 'fileNode.appe');
    service.update(await sourcesOf(hello, { generator }));
    const at = after(generator, 'fileNode.appe');
    const c = service.complete('generator', at);
    assert.equal(c.from, at - 4);
    assert.ok(['append', 'appendNewLine', 'appendTemplate', 'indent'].every(l => c.items.some(i => i.label === l)));
});

await test('hover shows the type and the documentation', async () => {
    const validator = hello.validator!;
    service.update(await sourcesOf(hello));
    assert.equal(service.hover('validator', after(validator, 'if (person.na')), '(property) Person.name: string');
    assert.match(service.hover('validator', after(validator, 'registry.regis')), /^\(method\) ValidationRegistry\.register<HelloWorldAstType>\(.*\n\nRegister a set of validation checks/s);
    assert.equal(service.hover('validator', 0), '');
});

await test('go to definition: inside the file, and into the AST types', async () => {
    const validator = hello.validator!;
    service.update(await sourcesOf(hello));
    const local = service.definition('validator', after(validator, 'Person: validator.checkPerson'))!;
    assert.equal(local.file, 'validator');
    assert.equal(validator.slice(local.from, local.to), 'checkPersonStartsWithCapital');
    const g = await analyzeGrammar(hello.grammar);
    const inAst = service.definition('validator', after(validator, 'checkPersonStartsWithCapital(person: Per'))!;
    assert.equal(inAst.file, 'ast');
    assert.equal(g.astSource.slice(inAst.from, inAst.to), 'Person');
    assert.equal(service.definition('validator', after(validator, 'registry.regis')), null);      // declared in Langium: not shown in the page
});

await test('rename: every use in the file', async () => {
    const validator = hello.validator!;
    service.update(await sourcesOf(hello));
    const r = service.rename('validator', after(validator, 'Person: validator.checkPerson'))!;
    assert.equal(r.name, 'checkPersonStartsWithCapital');
    assert.equal(r.spans.length, 2);
    assert.equal(service.rename('validator', after(validator, 'registry.regis')), null);
    assert.equal(service.rename('validator', 0), null);
});

await test('when the grammar changes, the types follow', async () => {
    const grammar = hello.grammar.replace("'person' name=ID;", "'person' name=ID ('aged' age=INT)?;");
    const g = await analyzeGrammar(grammar);
    const validator = hello.validator!.replace('if (person.name) {', 'if (person.age! > 150) {');
    service.update({ validator, generator: '', ast: g.astSource, name: g.name });
    assert.deepEqual(messages(service.diagnostics('validator')), []);
    service.update({ ...(await sourcesOf(hello)), validator });
    assert.match(messages(service.diagnostics('validator'))[0], /Property 'age' does not exist on type 'Person'/);
});

console.log(`TypeScript service tests passed (${n}) in ${((performance.now() - started) / 1000).toFixed(1)} s`);
