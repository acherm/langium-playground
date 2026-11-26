// Tests of the user code side: a validator and a generator written in TypeScript, as in a Langium
// project, run against the interpreted grammar. Plain Node.
import assert from 'node:assert/strict';
import { analyzeGrammar, analyzeProgram } from '../src/analysis.ts';
import { EXAMPLES } from '../src/examples.ts';

let n = 0;
async function test(name: string, fn: () => Promise<void>) {
    await fn();
    console.log(`  ok ${++n} ${name}`);
}
const hello = EXAMPLES.find(e => e.name === 'Hello world')!;
const chuno = EXAMPLES.find(e => e.name === 'Chess-Uno')!;
const brief = (ps: { line: number; col: number; severity: string; source: string; message: string }[]) =>
    ps.map(p => `${p.line}:${p.col} ${p.severity} ${p.source}: ${p.message}`);

await test('the validator of the Langium template, unchanged, adds its warning', async () => {
    const g = await analyzeGrammar(hello.grammar, { validator: hello.validator });
    assert.deepEqual([g.ok, g.validator, g.entry], [true, [], 'Model']);
    const r = await analyzeProgram('person alice\nHello alice !\n');
    assert.deepEqual(brief(r.problems), ['1:8 warning validation: Person name should start with a capital.']);
    assert.deepEqual((await analyzeProgram('person Alice\n')).problems, []);
});

await test('the generator of the Langium template, unchanged, writes its file', async () => {
    await analyzeGrammar(hello.grammar, hello);
    const r = await analyzeProgram('person Alice\nperson Bob\nHello Alice !\nHello Bob !\n', 'foo.hello');
    assert.equal(r.generated, 'ok');
    assert.deepEqual(r.output!.files, [{ path: 'generated/foo.js', content: `"use strict";\n\nconsole.log('Hello, Alice!');\nconsole.log('Hello, Bob!');\n` }]);
    assert.equal(r.output!.result, undefined);          // it returned the path of the file it wrote
});

await test('Chess-Uno: the three checks of the validator', async () => {
    const g = await analyzeGrammar(chuno.grammar, chuno);
    assert.deepEqual([g.ok, g.validator, g.generator], [true, [], []]);
    const r = await analyzeProgram('game G\ndeck { 0 x A 2 x B }\ncard A : move 0\ncard B : move 4\ncard A : pass\nwin by checkmate\n');
    assert.deepEqual(brief(r.problems), [
        '2:8 error validation: A deck entry needs at least one card.',
        '3:15 error validation: A card must move at least once.',
        '4:15 warning validation: With 4 moves in a row, the first card can win the game.',
        "5:6 error validation: Card 'A' is declared twice.",
    ]);
    assert.equal(r.generated, 'skipped');
    assert.equal(r.output, undefined);
});

await test('Chess-Uno: the generator returns the rules in English, with the type guards of ast.js', async () => {
    await analyzeGrammar(chuno.grammar, chuno);
    for (const p of chuno.programs.filter(p => !p.name.startsWith('rejected'))) {
        const r = await analyzeProgram(p.text, p.name);
        assert.equal(r.generated, 'ok', p.name);
        assert.deepEqual(r.output!.files, []);
        assert.match(r.output!.result!, /^\w+\n\nTwo players play chess/);
    }
    const video = await analyzeProgram(chuno.programs[0].text);
    assert.match(video.output!.result!, /The deck has 56 cards, shuffled: 8 One, 8 Two/);
    assert.match(video.output!.result!, /- Four: you play 4 moves in a row\.\n- Skip: you lose the turn\./);
    assert.match(video.output!.result!, /A move that gives check ends your series/);
    assert.equal(brief(video.problems).length, 1);      // the warning on move 4 does not stop the generator
});

await test('no code: nothing changes, and no generator is reported', async () => {
    await analyzeGrammar(hello.grammar, { validator: '  \n', generator: '' });
    const r = await analyzeProgram('person alice\n');
    assert.deepEqual([r.problems, r.generated, r.output, r.generatorProblems], [[], 'none', undefined, []]);
});

await test('a syntax error in the validator is located, and programs are not analysed', async () => {
    const g = await analyzeGrammar(hello.grammar, { validator: hello.validator!.replace('registry.register(checks, validator);', 'registry.register(checks, validator;') });
    assert.equal(g.ok, false);
    assert.equal(g.validator.length, 1);
    assert.deepEqual([g.validator[0].line, g.validator[0].severity, g.validator[0].source], [14, 'error', 'validator']);
    await assert.rejects(analyzeProgram('person Alice\n'));
});

await test('an error while registering the checks is located on its line', async () => {
    const g = await analyzeGrammar(hello.grammar, { validator: hello.validator!.replace('validator.checkPersonStartsWithCapital', 'services.validation.Missing.check') });
    assert.equal(g.ok, false);
    assert.match(g.validator[0].message, /TypeError/);
    assert.equal(g.validator[0].line, 12);
});

await test('a validator without registerValidationChecks: a warning, programs still analysed', async () => {
    const g = await analyzeGrammar(hello.grammar, { validator: 'export class HelloWorldValidator {}\n' });
    assert.equal(g.ok, true);
    assert.deepEqual([g.validator[0].severity, /registerValidationChecks/.test(g.validator[0].message)], ['warning', true]);
});

await test('a check that throws becomes a problem of the program, not a crash', async () => {
    const g = await analyzeGrammar(hello.grammar, { validator: hello.validator!.replace('if (person.name) {', 'if ((person as any).nope.length) {') });
    assert.equal(g.ok, true);
    const r = await analyzeProgram('person Alice\n');
    assert.match(r.problems[0].message, /An error occurred during validation/);
});

await test('a generator that throws: located in the generator, what it printed before is kept', async () => {
    const generator = `import type { Model } from './generated/ast.js';\n\nexport function generate(model: Model): string {\n    console.log('persons:', model.persons.length);\n    return (model as any).nothing.here;\n}\n`;
    const g = await analyzeGrammar(hello.grammar, { generator });
    assert.deepEqual([g.ok, g.generator], [true, []]);
    const r = await analyzeProgram('person Alice\n');
    assert.equal(r.generated, 'failed');
    assert.deepEqual(r.output!.console, ['persons: 1']);
    assert.deepEqual([r.generatorProblems[0].line, r.generatorProblems[0].source], [5, 'generator']);
    assert.match(r.generatorProblems[0].message, /TypeError/);
});

await test('a generator can return an object, print, and write several files', async () => {
    const generator = `import * as fs from 'node:fs';\nimport { isPerson } from './generated/ast.js';\nimport { AstUtils } from 'langium';\n\nexport default async function (model: any, file: string) {\n    const persons = AstUtils.streamAllContents(model).filter(isPerson).map(p => p.name).toArray();\n    for (const p of persons) fs.writeFileSync(\`out/\${p}.txt\`, 'Hello ' + p);\n    console.log(model.persons[0]);\n    return { file, persons };\n}\n`;
    await analyzeGrammar(hello.grammar, { generator });
    const r = await analyzeProgram('person Alice\nperson Bob\n', 'two.hello');
    assert.equal(r.generated, 'ok');
    assert.deepEqual(r.output!.files.map(f => f.path), ['out/Alice.txt', 'out/Bob.txt']);
    assert.deepEqual(JSON.parse(r.output!.result!), { file: 'two.hello', persons: ['Alice', 'Bob'] });
    assert.deepEqual(JSON.parse(r.output!.console[0]), { $type: 'Person', name: 'Alice' });
});

await test('what cannot be imported, or does not exist in the AST, is said clearly', async () => {
    const a = await analyzeGrammar(hello.grammar, { generator: `import chalk from 'chalk';\nexport function generate() { return chalk.red('x'); }\n` });
    assert.match(a.generator[0].message, /Cannot import 'chalk'/);
    await analyzeGrammar(hello.grammar, { generator: `import { isAnimal } from './generated/ast.js';\nexport function generate(m: any) { return isAnimal(m); }\n` });
    const r = await analyzeProgram('person Alice\n');
    assert.match(r.generatorProblems[0].message, /'isAnimal' is not exported by \.\/generated\/ast\.js.*Types: .*Person/);
    const b = await analyzeGrammar(hello.grammar, { generator: 'export const x = 1;\n' });
    assert.match(b.generator[0].message, /No generator function found/);
});

await test('each program gets its own output', async () => {
    await analyzeGrammar(hello.grammar, hello);
    const one = await analyzeProgram('person Alice\nHello Alice !\n', 'a.hello');
    const two = await analyzeProgram('person Bob\nHello Bob !\n', 'b.hello');
    assert.deepEqual(one.output!.files.map(f => f.path), ['generated/a.js']);
    assert.deepEqual(two.output!.files.map(f => f.path), ['generated/b.js']);
});

console.log(`user code tests passed (${n})`);
