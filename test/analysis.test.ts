// Tests of the Langium side (src/analysis.ts), in plain Node: no browser, no network.
//   npm test
import assert from 'node:assert/strict';
import { analyzeGrammar, analyzeProgram, complete, definition, format, hover, occurrences, rename, renameTarget } from '../src/analysis.ts';
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
    assert.deepEqual((await complete('program','', 0)).map(c => c.label).sort(), ['Hello', 'person']);
    const refs = await complete('program','person Alice\nHello ', 19);
    assert.deepEqual(refs.map(c => [c.label, c.kind]), [['Alice', 'reference']]);
    const partial = await complete('program','per', 3);
    assert.deepEqual([partial[0].label, partial[0].from, partial[0].to], ['person', 0, 3]);
});

await test('after an invalid grammar, the previous one is no longer used', async () => {
    await analyzeGrammar(hello.grammar);
    await analyzeGrammar('grammar Broken\nentry Model: x=Nope;\n');
    await assert.rejects(analyzeProgram('person Alice\n'));
    assert.deepEqual(await complete('program','', 0), []);
});

// ---- editor features, on a program and on the grammar itself

/** Applies edits to a text, as the editor does. */
const applyEdits = (text: string, edits: { from: number; to: number; insert: string }[]) =>
    [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
const at = (text: string, needle: string, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
    assert.ok(i >= 0, `"${needle}" #${nth} not found`);
    return i + 1;       // inside the word
};

await test('program: definition, occurrences and rename follow the cross-references', async () => {
    await analyzeGrammar(hello.grammar);
    const text = 'person Alice\nperson Bob\nHello Alice !\nHello Bob !\nHello Alice !\n';
    const use = at(text, 'Alice', 1);
    assert.deepEqual(await definition('program', text, use), { from: 7, to: 12 });
    assert.equal((await occurrences('program', text, use)).length, 3);
    assert.deepEqual(await renameTarget('program', text, use), { from: use - 1, to: use + 4, name: 'Alice' });
    const renamed = applyEdits(text, await rename('program', text, use, 'Carol'));
    assert.equal(renamed, 'person Carol\nperson Bob\nHello Carol !\nHello Bob !\nHello Carol !\n');
    assert.deepEqual((await analyzeProgram(renamed)).problems, []);
    assert.equal(await definition('program', text, at(text, 'Hello')), null);
    assert.equal(await renameTarget('program', text, at(text, 'Hello')), null);
});

await test('grammar: definition of a rule from a call and from a cross-reference', async () => {
    const g = hello.grammar;
    const declared = g.indexOf('Person:\n');
    assert.deepEqual(await definition('grammar', g, at(g, 'Person')), { from: declared, to: declared + 6 });
    assert.deepEqual(await definition('grammar', g, at(g, '[Person') + 1), { from: declared, to: declared + 6 });
    assert.ok((await occurrences('grammar', g, declared + 1)).length >= 3);
});

await test('grammar: renaming a rule changes its declaration and every use, and the grammar still works', async () => {
    const g = hello.grammar;
    const renamed = applyEdits(g, await rename('grammar', g, at(g, 'Person'), 'Human'));
    assert.equal(renamed.includes('Person'), false);
    assert.match(renamed, /persons\+=Human \|/);
    assert.match(renamed, /person=\[Human:ID\]/);
    assert.equal((await analyzeGrammar(renamed)).ok, true);
    assert.deepEqual((await analyzeProgram(hello.programs[0].text)).problems, []);
});

await test('grammar: completion proposes rules and keywords of the grammar language', async () => {
    const g = hello.grammar.replace("'person' name=ID;", "'person' name=");
    const labels = (await complete('grammar', g, g.indexOf('name=') + 5)).map(c => c.label);
    assert.ok(labels.includes('ID') && labels.includes('Person'), labels.join());
});

await test('grammar: formatting changes the layout only, and nothing when the grammar does not parse', async () => {
    const messy = "grammar   M\nentry Model:persons+=Person*;\nPerson:'person'    name=ID;\nhidden terminal WS:/\\s+/;\nterminal ID:/[a-z]+/;\n";
    const formatted = applyEdits(messy, await format('grammar', messy));
    assert.notEqual(formatted, messy);
    assert.equal(formatted.replace(/\s+/g, ''), messy.replace(/\s+/g, ''));
    assert.equal((await analyzeGrammar(formatted)).ok, true);
    assert.deepEqual(await format('grammar', 'grammar M\nentry Model: persons+=;'), []);
});

await test('hover shows the documentation comment of the element', async () => {
    const g = hello.grammar.replace('Person:\n', '/** Somebody to greet. */\nPerson:\n');
    assert.match(await hover('grammar', g, at(g, '+=Person') + 3), /Somebody to greet/);
    assert.equal(await hover('grammar', g, 0), '');
});

await test('a feature asked on a program without a valid grammar gives nothing, and does not throw', async () => {
    await analyzeGrammar('grammar Broken\nentry Model: x=Nope;\n');
    assert.equal(await definition('program', 'person Alice', 8), null);
    assert.deepEqual(await rename('program', 'person Alice', 8, 'Bob'), []);
});

console.log(`analysis tests passed (${n})`);
