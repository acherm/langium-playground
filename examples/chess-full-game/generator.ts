// Model-to-text transformation: a game of chess -> a web page that plays it back.
// The page shows the board, the list of moves, and buttons to go to the previous or next move.
// It is written to an .html file: the playground shows such a file as a live preview.
//
// The generator replays the game with the rules written in the validator (a generator runs on
// valid programs only, so every move is known to be legal), and puts in the page the positions
// it went through. The page itself knows nothing about chess: it displays position number i.
import type { Game } from '../language/generated/ast.js';
import { inCheck, initialPosition, movesOf, notation, play, toStep } from '../language/chess-full-game-validator.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CompositeGeneratorNode, NL, toString } from 'langium/generate';
import { extractDestinationAndName } from './cli-util.js';

/** One position of the game, as the page needs it. */
interface Frame {
    board: string;      // 64 characters, a1 first: a piece letter, or '.' for an empty square
    label: string;      // '12. O-O-O', '12... Ra8-d8', or 'Start'
    from: number;       // the squares of the move that led here (-1 at the start)
    to: number;
    check: boolean;
}

function framesOf(game: Game): Frame[] {
    let position = initialPosition();
    const frames: Frame[] = [{ board: position.board.map(p => p || '.').join(''), label: 'Start', from: -1, to: -1, check: false }];
    movesOf(game).forEach((move, index) => {
        const step = toStep(move, position.turn);
        const number = Math.floor(index / 2) + 1;
        const label = number + (position.turn === 'w' ? '. ' : '... ') + notation(move);
        position = play(position, step);
        frames.push({
            board: position.board.map(p => p || '.').join(''),
            label, from: step.from, to: step.to,
            check: inCheck(position.board, position.turn),
        });
    });
    return frames;
}

/** Text that goes between tags: the characters that would be read as markup are replaced. */
function text(value: string | undefined): string {
    return (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generateHtml(game: Game, filePath: string, destination: string | undefined): string {
    const data = extractDestinationAndName(filePath, destination);
    const generatedFilePath = path.join(data.destination, data.name) + '.html';
    const players = [game.white, game.black].filter(Boolean).join(' – ');
    const details = [players, game.event, game.date].filter(Boolean).join(' · ');
    // The game travels to the page as JSON ("<" is escaped: the text sits inside a script element).
    const json = JSON.stringify({ frames: framesOf(game), result: game.result ?? '' }).replace(/</g, '\\u003c');

    const page = new CompositeGeneratorNode();
    page.append('<!doctype html>', NL, '<html lang="en">', NL, '<head>', NL);
    page.append('<meta charset="utf-8">', NL, '<title>', text(game.name), '</title>', NL);
    page.append('<style>', NL, STYLE, NL, '</style>', NL, '</head>', NL, '<body>', NL);
    page.append('<h1>', text(game.name), '</h1>', NL);
    page.append('<p class="details">', text(details), '</p>', NL);
    page.append('<div class="layout">', NL);
    page.append('<div>', NL, '<div id="board"></div>', NL);
    page.append('<div class="controls">', NL);
    page.append('<button id="first" title="Start (Home)">⏮</button>', NL);
    page.append('<button id="prev" title="Previous move (left arrow)">◀ Prev</button>', NL);
    page.append('<button id="next" title="Next move (right arrow)">Next ▶</button>', NL);
    page.append('<button id="last" title="End (End)">⏭</button>', NL);
    page.append('</div>', NL, '<p id="status"></p>', NL, '</div>', NL);
    page.append('<div id="moves"></div>', NL);
    page.append('</div>', NL);
    page.append('<script>', NL, 'var game = ', json, ';', NL, SCRIPT, NL, '</script>', NL);
    page.append('</body>', NL, '</html>', NL);

    if (!fs.existsSync(data.destination)) {
        fs.mkdirSync(data.destination, { recursive: true });
    }
    fs.writeFileSync(generatedFilePath, toString(page));
    return generatedFilePath;
}

const STYLE = [
    'body { font: 14px system-ui, sans-serif; margin: 14px; color: #1c2330; background: #fff; }',
    'h1 { font-size: 17px; margin: 0; }',
    '.details { color: #667085; margin: 2px 0 12px; }',
    '.layout { display: flex; gap: 18px; flex-wrap: wrap; align-items: flex-start; }',
    '#board { display: grid; grid-template-columns: repeat(8, 38px); grid-template-rows: repeat(8, 38px); border: 2px solid #5b4636; width: max-content; }',
    '.square { position: relative; display: flex; align-items: center; justify-content: center; }',
    '.light { background: #f0d9b5; } .dark { background: #b58863; }',
    '.moved.light { background: #f7ec74; } .moved.dark { background: #dac34b; }',
    '.piece { font-size: 30px; line-height: 1; }',
    '.piece.w { color: #fff; text-shadow: 0 0 2px #000, 0 0 2px #000, 0 1px 1px #000; }',
    '.piece.b { color: #111; text-shadow: 0 0 1px #fff; }',
    '.coord { position: absolute; left: 2px; bottom: 0; font-size: 9px; color: #5b4636; opacity: 0.8; }',
    '.controls { display: flex; gap: 6px; margin-top: 10px; }',
    'button { font: inherit; padding: 5px 10px; border: 1px solid #c9ced8; border-radius: 6px; background: #f4f5f7; color: inherit; cursor: pointer; }',
    'button:disabled { opacity: 0.4; cursor: default; }',
    '#status { margin: 8px 0 0; font-weight: 600; min-height: 1.4em; }',
    '#moves { display: grid; grid-template-columns: auto auto auto; gap: 2px 10px; align-content: start; max-height: 330px; overflow-y: auto; font-variant-numeric: tabular-nums; }',
    '.number { color: #667085; text-align: right; }',
    '.move { padding: 1px 6px; border-radius: 4px; cursor: pointer; }',
    '.move:hover { background: #eef1f6; }',
    '.move.current { background: #a4161a; color: #fff; }',
    '@media (prefers-color-scheme: dark) {',
    '  body { color: #e3e6ec; background: #1b1e25; }',
    '  button { background: #252a33; border-color: #3a4050; }',
    '  .move:hover { background: #252a33; }',
    '}',
].join('\n');

// The program of the page. It knows nothing about chess: it shows frame number `index`.
const SCRIPT = [
    // The filled glyphs are used for both sides (the colour comes from the style); U+FE0E keeps them text.
    'var GLYPH = { K: "\\u265a", Q: "\\u265b", R: "\\u265c", B: "\\u265d", N: "\\u265e", P: "\\u265f" };',
    'var index = 0, last = game.frames.length - 1;',
    'function element(tag, className, text) {',
    '  var e = document.createElement(tag);',
    '  e.className = className; e.textContent = text;',
    '  return e;',
    '}',
    'function show(i) { index = Math.max(0, Math.min(last, i)); render(); }',
    'function render() {',
    '  var frame = game.frames[index], board = document.getElementById("board"), moves = document.getElementById("moves");',
    '  board.textContent = ""; moves.textContent = "";',
    '  for (var rank = 7; rank >= 0; rank--) {',
    '    for (var file = 0; file < 8; file++) {',
    '      var square = file + 8 * rank, piece = frame.board.charAt(square);',
    '      var moved = square === frame.from || square === frame.to;',
    '      var cell = element("div", "square " + ((file + rank) % 2 ? "light" : "dark") + (moved ? " moved" : ""), "");',
    '      if (piece !== ".") cell.appendChild(element("span", piece === piece.toUpperCase() ? "piece w" : "piece b", GLYPH[piece.toUpperCase()] + "\\ufe0e"));',
    '      if (file === 0) cell.appendChild(element("span", "coord", String(rank + 1)));',
    '      board.appendChild(cell);',
    '    }',
    '  }',
    '  game.frames.forEach(function (f, i) {',
    '    if (i === 0) return;',
    '    if (i % 2 === 1) moves.appendChild(element("span", "number", ((i + 1) / 2) + "."));',
    '    var item = element("span", i === index ? "move current" : "move", f.label.replace(/^[0-9]+\\.+ /, ""));',
    '    item.onclick = function () { show(i); };',
    '    moves.appendChild(item);',
    '  });',
    '  var note = index === last && last > 0 && game.result ? "  " + game.result : "";',
    '  document.getElementById("status").textContent = frame.label + (frame.check ? (/#$/.test(frame.label) ? "  checkmate" : "  check") : "") + note;',
    '  document.getElementById("first").disabled = document.getElementById("prev").disabled = index === 0;',
    '  document.getElementById("next").disabled = document.getElementById("last").disabled = index === last;',
    '}',
    'document.getElementById("first").onclick = function () { show(0); };',
    'document.getElementById("prev").onclick = function () { show(index - 1); };',
    'document.getElementById("next").onclick = function () { show(index + 1); };',
    'document.getElementById("last").onclick = function () { show(last); };',
    'document.onkeydown = function (event) {',
    '  if (event.key === "ArrowLeft") show(index - 1);',
    '  else if (event.key === "ArrowRight") show(index + 1);',
    '  else if (event.key === "Home") show(0);',
    '  else if (event.key === "End") show(last);',
    '};',
    'render();',
].join('\n');
