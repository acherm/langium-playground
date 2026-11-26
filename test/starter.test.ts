// The starting files offered for a language without validator or generator: for every example
// grammar they must type-check (TypeScript service) and run (Langium, in src/usercode.ts).
import assert from 'node:assert/strict';
import { analyzeGrammar, analyzeProgram } from '../src/analysis.ts';
import { EXAMPLES } from '../src/examples.ts';
import { generatorStarter, languageName, newLanguage, validatorStarter } from '../src/starter.ts';
import { createService } from '../src/tsservice.ts';
import { collectDeclarations } from '../tools/dts.mjs';

const service = createService(collectDeclarations());
let n = 0;
const messages = (ps: { line: number; message: string }[]) => ps.map(p => `${p.line}: ${p.message}`);

for (const ex of EXAMPLES) {
    const info = await analyzeGrammar(ex.grammar);
    const validator = validatorStarter(info), generator = generatorStarter(info);

    service.update({ validator, generator, ast: info.astSource, name: info.name });
    assert.deepEqual(messages(service.diagnostics('validator')), [], `${ex.name}: validator starter type-checks\n${validator}`);
    assert.deepEqual(messages(service.diagnostics('generator')), [], `${ex.name}: generator starter type-checks\n${generator}`);

    const g = await analyzeGrammar(ex.grammar, { validator, generator });
    assert.deepEqual([g.ok, g.validator, g.generator], [true, [], []], ex.name);
    const program = ex.programs.find(p => !p.name.startsWith('rejected'))!;
    const r = await analyzeProgram(program.text, program.name);
    assert.deepEqual(r.problems, [], ex.name);
    assert.equal(r.generated, 'ok', ex.name);
    assert.match(r.output!.result!, new RegExp(`^A ${info.entry}\\b`), ex.name);
    console.log(`  ok ${++n} ${ex.name}: both starters type-check and run  (${r.output!.result!.replace(/\n/g, ' · ')})`);
}

// Names that would not be valid TypeScript are avoided, and a grammar without types still gets a file.
const odd = validatorStarter({ name: 'Odd', entry: 'Class', types: [{ name: 'Class', properties: [{ name: 'name', array: false, optional: false }] }, { name: 'Type', properties: [] }] });
assert.match(odd, /checkClass\(classNode: Class, accept: ValidationAcceptor\)/);
assert.match(odd, /checkType\(typeNode: Type, accept: ValidationAcceptor\)/);
assert.match(validatorStarter({ name: 'HTTPServerConfig', entry: 'Model', types: [] }), /from '\.\/http-server-config-module\.js'/);
assert.match(generatorStarter({ name: '', entry: '', types: [] }), /export function generate\(model: Model\): string/);
console.log(`  ok ${++n} awkward names (Class, Type, acronyms) and an empty grammar are handled`);

// A new language: the grammar works, its program is accepted, and the starting files fit it.
for (const [raw, expected] of [['Robots', 'Robots'], ['my dsl', 'MyDsl'], ['my-little_dsl 2', 'MyLittleDsl2'], ['42', 'MyDsl'], ['', 'MyDsl']]) {
    assert.equal(languageName(raw), expected);
}
const fresh = newLanguage('game of life');
assert.equal(fresh.name, 'GameOfLife');
assert.equal(fresh.program.name, 'example.gameoflife');
const info = await analyzeGrammar(fresh.grammar);
assert.deepEqual([info.ok, info.problems.filter(p => p.severity !== 'info'), info.entry], [true, [], 'Model']);
const validator = validatorStarter(info), generator = generatorStarter(info);
service.update({ validator, generator, ast: info.astSource, name: info.name });
assert.deepEqual([...service.diagnostics('validator'), ...service.diagnostics('generator')], []);
assert.equal((await analyzeGrammar(fresh.grammar, { validator, generator })).ok, true);
const run = await analyzeProgram(fresh.program.text, fresh.program.name);
assert.deepEqual([run.problems, run.output?.result], [[], 'A Model\n2 elements']);
assert.equal(JSON.parse(run.ast).elements[1].previous.$refText, 'first');
console.log(`  ok ${++n} a new language: valid grammar, accepted program, starting files that type-check and run`);
console.log(`starter tests passed (${n})`);
