// The "Chess (full game)" example (examples/chess-full-game/): a grammar for complete games, a
// validator that knows the rules of chess, a generator to a page that plays the game back.
// Plain Node: the page is checked by running its script against a stand-in for a document.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { analyzeGrammar, analyzeProgram } from '../src/analysis.ts';
import { EXAMPLES } from '../src/examples.ts';
import { createService } from '../src/tsservice.ts';
import { collectDeclarations } from '../tools/dts.mjs';

let n = 0;
const ok = (name: string) => console.log(`  ok ${++n} ${name}`);
const ex = EXAMPLES.find(e => e.name === 'Chess (full game)')!;
const program = (name: string) => ex.programs.find(p => p.name === name)!;
const brief = (ps: { line: number; col: number; severity: string; message: string }[]) => ps.map(p => `${p.line}:${p.col} ${p.severity}: ${p.message}`);

assert.deepEqual(EXAMPLES.map(e => e.name), ['Hello world', 'Chess', 'Chess (full game)', 'VideoGenerator', 'Poll', 'Chess-Uno', 'State machine']);
const info = await analyzeGrammar(ex.grammar, ex);
assert.deepEqual([info.ok, info.name, info.problems.filter(p => p.severity !== 'info'), info.validator, info.generator], [true, 'ChessFullGame', [], [], []]);
ok('the grammar is accepted; the validator loads; the generator loads and imports the validator');

const service = createService(collectDeclarations());
service.update({ validator: ex.validator!, generator: ex.generator!, ast: info.astSource, name: info.name });
assert.deepEqual(brief(service.diagnostics('validator')), []);
assert.deepEqual(brief(service.diagnostics('generator')), []);
const at = ex.generator!.indexOf('initialPosition()') + 3;
assert.match(service.hover('generator', at), /^\(alias\) initialPosition\(\): Position/);
assert.deepEqual(service.definition('generator', at)?.file, 'validator');
ok('validator and generator have no type error; the generator sees the types of what it imports from the validator');

// ---- the games of the example

/** Runs the script of a generated page; returns what a reader would see, and ways to act. */
function open(html: string) {
    const script = /<script>\n([\s\S]*)\n<\/script>/.exec(html)![1];
    const make = (tag: string) => {
        const e: any = { tag, className: '', disabled: false, onclick: null, children: [] as any[], _text: '' };
        Object.defineProperty(e, 'textContent', { get: () => e._text, set: (v: string) => { e._text = v; if (v === '') e.children = []; } });
        e.appendChild = (c: any) => { e.children.push(c); return c; };
        return e;
    };
    const byId: Record<string, any> = {};
    for (const id of ['board', 'moves', 'status', 'first', 'prev', 'next', 'last']) { assert.ok(html.includes(`id="${id}"`), id); byId[id] = make('div'); }
    const document: any = { getElementById: (id: string) => byId[id], createElement: make, onkeydown: null };
    vm.runInNewContext(script, { document });
    /** The piece shown on a square: 'wK', 'bP'..., or '' (the board is drawn from a8 to h1). */
    const on = (name: string) => {
        const file = 'abcdefgh'.indexOf(name[0]), rank = Number(name[1]) - 1;
        const cell = byId.board.children[(7 - rank) * 8 + file];
        const piece = cell.children.find((c: any) => c.className.startsWith('piece'));
        const letter: Record<string, string> = { '♚': 'K', '♛': 'Q', '♜': 'R', '♝': 'B', '♞': 'N', '♟': 'P' };
        return piece ? piece.className.slice(-1) + letter[piece._text.charAt(0)] : '';
    };
    return {
        on,
        pieces: () => byId.board.children.filter((c: any) => c.children.some((k: any) => k.className.startsWith('piece'))).length,
        status: () => byId.status._text,
        highlighted: () => byId.board.children.filter((c: any) => c.className.includes('moved')).length,
        moves: () => byId.moves.children.filter((c: any) => c.className.startsWith('move')).map((c: any) => c._text),
        current: () => byId.moves.children.filter((c: any) => c.className === 'move current').map((c: any) => c._text).join(),
        click: (id: string) => { if (!byId[id].disabled) byId[id].onclick(); },
        disabled: (id: string) => byId[id].disabled,
        key: (key: string) => document.onkeydown({ key }),
        jump: (i: number) => byId.moves.children.filter((c: any) => c.className.startsWith('move'))[i].onclick(),
    };
}

const opera = await analyzeProgram(program('opera.chess').text, 'opera.chess');
assert.deepEqual(brief(opera.problems), []);
assert.deepEqual([opera.generated, opera.output!.files.map(f => f.path)], ['ok', ['generated/opera.html']]);
ok('the Opera Game (Morphy, 1858): 33 moves, all legal, every x + # and the result confirmed by the validator');

const html = opera.output!.files[0].content;
assert.match(html, /<h1>The Opera Game<\/h1>/);
assert.match(html, /Paul Morphy – Duke of Brunswick and Count Isouard · Paris, Opera · 1858/);
const page = open(html);
assert.deepEqual([page.pieces(), page.status(), page.on('e1'), page.on('d8'), page.on('e2'), page.highlighted()], [32, 'Start', 'wK', 'bQ', 'wP', 0]);
assert.deepEqual([page.disabled('prev'), page.disabled('first'), page.disabled('next')], [true, true, false]);
assert.equal(page.moves().length, 33);
assert.deepEqual(page.moves().slice(0, 3), ['e2-e4', 'e7-e5', 'Ng1-f3']);
page.click('next');
assert.deepEqual([page.status(), page.on('e2'), page.on('e4'), page.highlighted(), page.current()], ['1. e2-e4', '', 'wP', 2, 'e2-e4']);
page.click('next');
assert.deepEqual([page.status(), page.on('e5')], ['1... e7-e5', 'bP']);
page.click('prev'); page.click('prev'); page.click('prev');
assert.equal(page.status(), 'Start');                                           // cannot go before the start
page.jump(22);                                                                  // 12. O-O-O
assert.deepEqual([page.status(), page.on('c1'), page.on('d1'), page.on('a1'), page.on('e1')], ['12. O-O-O', 'wK', 'wR', '', '']);
page.key('ArrowRight'); page.key('ArrowLeft'); page.key('ArrowLeft');
assert.equal(page.status(), '11... Nb8-d7');
page.key('ArrowLeft');
assert.equal(page.status(), '11. Bc4xb5+  check');
page.click('last');
assert.deepEqual([page.status(), page.on('d8'), page.on('e8'), page.on('b8'), page.pieces()], ['17. Rd1-d8#  checkmate  1-0', 'wR', 'bK', 'bN', 20]);      // 12 captures in the game
assert.deepEqual([page.disabled('next'), page.disabled('last'), page.disabled('prev')], [true, true, false]);
page.key('Home');
assert.equal(page.status(), 'Start');
ok('its page: start position, next and previous, jump to a move, keyboard, castling, check, the final checkmate');

const special = await analyzeProgram(program('special-moves.chess').text, 'special-moves.chess');
assert.deepEqual(brief(special.problems), []);
const sp = open(special.output!.files[0].content);
sp.jump(4);                                                                     // 3. e5xd6, en passant
assert.deepEqual([sp.status(), sp.on('d6'), sp.on('d5'), sp.on('e5')], ['3. e5xd6', 'wP', '', '']);
sp.jump(8);                                                                     // 5. c7xd8=Q+
assert.deepEqual([sp.status(), sp.on('d8'), sp.on('c7')], ['5. c7xd8=Q+  check', 'wQ', '']);
sp.click('last');
assert.deepEqual([sp.on('g1'), sp.on('f1'), sp.on('h1'), sp.on('b1'), sp.on('a1')], ['wK', 'wR', '', 'bQ', '']);
ok('special moves: en passant, promotion with check, castling, all accepted and shown correctly');

const illegal = await analyzeProgram(program('illegal.chess').text, 'illegal.chess');
assert.deepEqual(brief(illegal.problems), ['7:4 error: A bishop cannot go from f1 to c5. The moves that follow are not checked.']);
assert.equal(illegal.generated, 'skipped');
ok('the illegal game: accepted by the grammar, rejected by the validator at the move that is not chess');

// ---- the validator, case by case

async function check(moves: string): Promise<string[]> {
    const r = await analyzeProgram(`game "t"\n${moves}\n`);
    return r.problems.map(p => `${p.severity}: ${p.message}`);
}
const cases: [string, string, RegExp[]][] = [
    ['a wrong piece letter', '1. Bg1-f3', [/^error: The piece on g1 is a knight: write Ng1, not Bg1\.$/]],
    ['a pawn written as a piece', '1. Ne2-e4', [/^error: The piece on e2 is a pawn: write e2, not Ne2\.$/]],
    ['an empty square', '1. e3-e4', [/^error: There is no piece on e3\./]],
    ["the other side's piece", '1. e7-e5', [/^error: It is White's turn, and the piece on e7 is black\./]],
    ['a square taken by an own piece', '1. Ra1-a2', [/^error: White already has a piece on a2\./]],
    ['a blocked way', '1. Ra1-a5', [/^error: The way from a1 to a5 is not free\./]],
    ['a pawn that goes backwards', '1. e2-e4 e7-e5 2. e4-e3', [/^error: A pawn cannot go from e4 to e3\./]],
    ['a capture not marked', '1. e2-e4 d7-d5 2. e4-d5', [/^warning: This move captures: write e4xd5\.$/]],
    ['a capture marked wrongly', '1. e2xe4', [/^error: Nothing is captured on e4: write e2-e4\.$/]],
    ['a check not marked', '1. e2-e4 f7-f6 2. Qd1-h5', [/^warning: This move gives check: mark it with \+\.$/]],
    ['a check that is not one', '1. e2-e4+', [/^error: This move does not give check\.$/]],
    ['a checkmate that is only a check', '1. e2-e4 f7-f6 2. Qd1-h5#', [/^error: This is check, but not checkmate: there is a way out\.$/]],
    ['a checkmate not marked', '1. f2-f3 e7-e5 2. g2-g4 Qd8-h4+', [/^warning: This move is checkmate: mark it with #\.$/]],
    ['a move after checkmate', '1. f2-f3 e7-e5 2. g2-g4 Qd8-h4# 3. a2-a3', [/^error: The game is over \(checkmate\): no move can follow\.$/]],
    ['a result that contradicts the checkmate', '1. f2-f3 e7-e5 2. g2-g4 Qd8-h4#\nresult 1-0', [/^error: Black gave checkmate: the result is 0-1\.$/]],
    ['a check that is ignored', '1. e2-e4 d7-d5 2. Bf1-b5+ a7-a6', [/^error: This move leaves the black king in check\./]],
    ['a checkmate marked as a check', '1. e2-e4 e7-e5 2. Qd1-h5 Ke8-e7 3. Qh5xe5+', [/^warning: This move is checkmate: mark it with #\.$/]],
    ['castling with pieces in between', '1. O-O', [/^error: Castling needs empty squares between the king and the rook\./]],
    ['castling after the king has moved', '1. e2-e4 e7-e5 2. Ng1-f3 Nb8-c6 3. Bf1-c4 Bf8-c5 4. Ke1-e2 d7-d6 5. Ke2-e1 Ng8-f6 6. O-O', [/^error: White can no longer castle on this side/]],
    ['castling across an attacked square', '1. e2-e4 b7-b6 2. Bf1-e2 Bc8-a6 3. Be2-g4 e7-e6 4. Ng1-f3 d7-d6 5. O-O', [/^error: The king cannot castle across an attacked square \(f1\)\./]],
    ['castling while in check', '1. e2-e4 e7-e5 2. Ng1-f3 Nb8-c6 3. Bf1-c4 a7-a6 4. d2-d4 Bf8-b4+ 5. O-O', [/^error: Castling is not allowed while the king is in check\./]],
    ['a promotion that is missing', '1. h2-h4 a7-a5 2. h4-h5 a5-a4 3. h5-h6 a4-a3 4. h6xg7 a3xb2 5. g7xh8', [/^error: A pawn that reaches the last rank is promoted: write h8=Q/]],
    ['a promotion to a king', '1. h2-h4 a7-a5 2. h4-h5 a5-a4 3. h5-h6 a4-a3 4. h6xg7 a3xb2 5. g7xh8=K', [/^error: A pawn cannot be promoted to a king\.$/]],
    ['a promotion in the middle of the board', '1. e2-e4=Q', [/^error: A pawn is promoted only when it reaches the last rank\./]],
    ['a wrong turn number', '1. e2-e4 e7-e5 3. Ng1-f3', [/^warning: This is turn 2, not 3\.$/]],
    ["a missing move of Black", '1. e2-e4 2. d2-d4 d7-d5', [/^error: Black's move is missing/, /^error: It is Black's turn, and the piece on d2 is white\./]],
    ['en passant too late', '1. e2-e4 a7-a6 2. e4-e5 d7-d5 3. a2-a3 a6-a5 4. e5xd6', [/^error: A pawn cannot go from e5 to d6\./]],
];
for (const [name, moves, expected] of cases) {
    const found = await check(moves);
    assert.equal(found.length, expected.length, `${name}: ${JSON.stringify(found)}`);
    expected.forEach((e, i) => assert.match(found[i], e, name));
}
ok(`the validator, case by case: ${cases.length} situations, each with the expected message`);

console.log(`chess tests passed (${n})`);
