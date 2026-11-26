// Tests of the Langium side (src/analysis.ts), in plain Node: no browser, no network.
//   npm test
import assert from 'node:assert/strict';
import { analyzeGrammar, analyzeProgram, complete } from '../src/analysis.ts';
import { EXAMPLES } from '../src/examples.ts';

const TERMINALS = `hidden terminal WS: /\\s+/;\nterminal ID: /[_a-zA-Z][\\w_]*/;\nterminal INT returns number: /[0-9]+/;\n`;
const errors = (problems: { severity: string }[]) => problems.filter(p => p.severity === 'error');
let n = 0;
async function test(name: string, fn: () => Promise<void>) {
    await fn();
    console.log(`  ok ${++n} ${name}`);
}

await test('every example of the course: grammar accepted, programs accepted', async () => {
    for (const ex of EXAMPLES) {
        const g = await analyzeGrammar(ex.grammar);
        assert.equal(g.ok, true, ex.name);
        assert.deepEqual(errors(g.problems), [], ex.name);
        for (const p of ex.programs) {
            const r = await analyzeProgram(p.text);
            if (p.name.startsWith('rejected')) {
                assert.match(r.problems[0].message, /Could not resolve reference to Card named 'Joker'/);
                continue;
            }
            assert.deepEqual(r.problems, [], `${ex.name} / ${p.name}`);
            assert.equal(JSON.parse(r.ast).$type !== undefined, true);
        }
    }
});

const hello = EXAMPLES.find(e => e.name === 'Hello world')!;

await test('program errors are located and attributed to a phase', async () => {
    await analyzeGrammar(hello.grammar);
    const r = await analyzeProgram('person Alice\nHello Bob !\nHello Alice ?\n');
    const linker = r.problems.find(p => p.source === 'linker')!;
    assert.match(linker.message, /Could not resolve reference to Person named 'Bob'/);
    assert.deepEqual([linker.line, linker.col, linker.from, linker.to], [2, 7, 19, 22]);
    const lexer = r.problems.find(p => p.source === 'lexer')!;
    assert.deepEqual([lexer.line, lexer.col], [3, 13]);
    assert.ok(r.problems.some(p => p.source === 'parser'));
});

await test('the AST carries types, values, references and text regions', async () => {
    await analyzeGrammar(hello.grammar);
    const ast = JSON.parse((await analyzeProgram('person Alice\nHello Alice !\n')).ast);
    assert.equal(ast.$type, 'Model');
    assert.equal(ast.persons[0].name, 'Alice');
    assert.equal(ast.greetings[0].person.$refText, 'Alice');
    assert.deepEqual([ast.greetings[0].$textRegion.offset, ast.greetings[0].$textRegion.end], [13, 26]);
    assert.deepEqual([ast.persons[0].$textRegion.assignments.name[0].offset, ast.persons[0].$textRegion.assignments.name[0].end], [7, 12]);
});

await test('tokens say what the lexer saw: keyword or terminal', async () => {
    const chess = EXAMPLES.find(e => e.name === 'Chess')!;
    await analyzeGrammar(chess.grammar);
    const r = await analyzeProgram('White: "a" Black: "b" K e1 e2 // king\n');
    const seen = r.tokens.map(t => `${t[2]}:${t[3]}`);
    assert.deepEqual(seen, ['keyword:White:', 'string:STRING', 'keyword:Black:', 'string:STRING', 'keyword:K', 'terminal:Square', 'terminal:Square', 'comment:SL_COMMENT']);
});

await test('programs do not see each other (no reference leaks from one tab to the next)', async () => {
    await analyzeGrammar(hello.grammar);
    assert.deepEqual((await analyzeProgram('person Alice\n')).problems, []);
    const second = await analyzeProgram('Hello Alice !\n');
    assert.match(second.problems[0].message, /Could not resolve reference/);
});

await test('grammar errors are located', async () => {
    const g = await analyzeGrammar(hello.grammar.replace("'person' name=ID;", "'person' name=IDD;"));
    assert.equal(g.ok, false);
    const p = errors(g.problems)[0] as any;
    assert.match(p.message, /Could not resolve reference to AbstractRule named 'IDD'/);
    assert.deepEqual([p.line, p.col], [7, 19]);
});

await test('left recursion (found by Chevrotain, not by the validator) is reported on the rule', async () => {
    const g = await analyzeGrammar(`grammar L\nentry Model: e=Expr;\nExpr: left=Expr '+' v=INT | v=INT;\n` + TERMINALS);
    assert.equal(g.ok, false);
    const p = g.problems.find(x => x.source === 'chevrotain')!;
    assert.match(p.message, /^Left Recursion found in grammar/);
    assert.deepEqual([p.severity, p.line, p.col], ['error', 3, 1]);
    assert.equal(/​/.test(p.message), false);
});

await test('ambiguous alternatives are reported as a warning on the grammar', async () => {
    const g = await analyzeGrammar(`grammar Amb\nentry Model: (a+=AA | b+=BB)*;\nAA: 'x' name=ID;\nBB: 'x' name=ID;\n` + TERMINALS);
    assert.equal(g.ok, true);
    const r = await analyzeProgram('x foo x bar');
    assert.equal(r.grammarWarnings.length, 1);
    assert.match(r.grammarWarnings[0].message, /^Ambiguous Alternatives Detected/);
    assert.deepEqual([r.grammarWarnings[0].severity, r.grammarWarnings[0].line], ['warning', 2]);
});

await test('nothing leaks to the console, and the console is restored', async () => {
    const log = console.log;
    await analyzeGrammar(`grammar Amb\nentry Model: (a+=AA | b+=BB)*;\nAA: 'x' name=ID;\nBB: 'x' name=ID;\n` + TERMINALS);
    await analyzeProgram('x foo x bar');
    assert.equal(console.log, log);
});

await test('completion proposes keywords and reference targets', async () => {
    await analyzeGrammar(hello.grammar);
    assert.deepEqual((await complete('', 0)).map(c => c.label).sort(), ['Hello', 'person']);
    const refs = await complete('person Alice\nHello ', 19);
    assert.deepEqual(refs.map(c => [c.label, c.kind]), [['Alice', 'reference']]);
    const partial = await complete('per', 3);
    assert.deepEqual([partial[0].label, partial[0].from, partial[0].to], ['person', 0, 3]);
});

await test('after an invalid grammar, the previous one is no longer used', async () => {
    await analyzeGrammar(hello.grammar);
    await analyzeGrammar('grammar Broken\nentry Model: x=Nope;\n');
    await assert.rejects(analyzeProgram('person Alice\n'));
    assert.deepEqual(await complete('', 0), []);
});

console.log(`analysis tests passed (${n})`);
