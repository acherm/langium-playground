// Validators and generators of the examples, as text: they are shown in the editors of the page.
// They are the files of the corresponding Langium projects, unchanged:
//   Hello world: src/language/hello-world-validator.ts and src/cli/generator.ts of acherm/dsl-langium
//   Chess-Uno:   the validator and the model-to-text transformation of MiniChuno

export const HELLO_VALIDATOR = `import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { HelloWorldAstType, Person } from './generated/ast.js';
import type { HelloWorldServices } from './hello-world-module.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: HelloWorldServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.HelloWorldValidator;
    const checks: ValidationChecks<HelloWorldAstType> = {
        Person: validator.checkPersonStartsWithCapital
    };
    registry.register(checks, validator);
}

/**
 * Implementation of custom validations.
 */
export class HelloWorldValidator {

    checkPersonStartsWithCapital(person: Person, accept: ValidationAcceptor): void {
        if (person.name) {
            const firstChar = person.name.substring(0, 1);
            if (firstChar.toUpperCase() !== firstChar) {
                accept('warning', 'Person name should start with a capital.', { node: person, property: 'name' });
            }
        }
    }

}
`;

export const HELLO_GENERATOR = `import type { Model } from '../language/generated/ast.js';
import * as fs from 'node:fs';
import { CompositeGeneratorNode, NL, toString } from 'langium/generate';
import * as path from 'node:path';
import { extractDestinationAndName } from './cli-util.js';

export function generateJavaScript(model: Model, filePath: string, destination: string | undefined): string {
    const data = extractDestinationAndName(filePath, destination);
    const generatedFilePath = \`\${path.join(data.destination, data.name)}.js\`;

    const fileNode = new CompositeGeneratorNode();
    fileNode.append('"use strict";', NL, NL);
    model.greetings.forEach(greeting => fileNode.append(\`console.log('Hello, \${greeting.person.ref?.name}!');\`, NL));

    if (!fs.existsSync(data.destination)) {
        fs.mkdirSync(data.destination, { recursive: true });
    }
    fs.writeFileSync(generatedFilePath, toString(fileNode));
    return generatedFilePath;
}
`;

export const CHUNO_VALIDATOR = `import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { DeckEntry, Game, MiniChunoAstType, Move } from './generated/ast.js';
import type { MiniChunoServices } from './mini-chuno-module.js';

/**
 * Register custom validation checks: for each type of node, the method that checks it.
 */
export function registerValidationChecks(services: MiniChunoServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.MiniChunoValidator;
    const checks: ValidationChecks<MiniChunoAstType> = {
        Move: validator.checkMove,
        DeckEntry: validator.checkDeckEntry,
        Game: validator.checkCardNames
    };
    registry.register(checks, validator);
}

/**
 * What the grammar cannot say.
 */
export class MiniChunoValidator {

    /** \`move 0\` is not a move; \`move 4\` is too strong. */
    checkMove(move: Move, accept: ValidationAcceptor): void {
        if (move.count === 0) {
            accept('error', 'A card must move at least once.', { node: move, property: 'count' });
        }
        if (move.count >= 4) {
            accept('warning', 'With 4 moves in a row, the first card can win the game.', { node: move, property: 'count' });
        }
    }

    /** \`0 x Skip\` puts nothing in the deck. */
    checkDeckEntry(entry: DeckEntry, accept: ValidationAcceptor): void {
        if (entry.count === 0) {
            accept('error', 'A deck entry needs at least one card.', { node: entry, property: 'count' });
        }
    }

    /** Two cards with the same name: which one does the deck mean? */
    checkCardNames(game: Game, accept: ValidationAcceptor): void {
        const names = new Set<string>();
        for (const card of game.cards) {
            if (names.has(card.name)) {
                accept('error', \`Card '\${card.name}' is declared twice.\`, { node: card, property: 'name' });
            }
            names.add(card.name);
        }
    }
}
`;

export const CHUNO_GENERATOR = `// Model-to-text transformation: a MiniChuno program -> the rules of the game in plain English
// (what one would give to a human player, or to an LLM).
import { expandToString } from 'langium/generate';
import { isDrop, isMove, isPass, type Card, type Game } from '../language/generated/ast.js';

/** What a card does, in English. */
export function describe(card: Card): string {
    if (isMove(card.effect)) {
        return card.effect.count === 1 ? 'play 1 move' : \`play \${card.effect.count} moves in a row\`;
    }
    if (isPass(card.effect)) return 'lose the turn';
    if (isDrop(card.effect)) return 'put back up to 2 captured pieces';
    return 'swap colours with the opponent';
}

export function toRulesText(game: Game): string {
    const total = game.deck.entries.reduce((sum, entry) => sum + entry.count, 0);
    const deck = game.deck.entries.map(entry => \`\${entry.count} \${entry.card.ref!.name}\`).join(', ');
    return expandToString\`
        \${game.name}

        Two players play chess on a standard board, with all the classical moves.
        The deck has \${total} cards, shuffled: \${deck}.
        On your turn you draw one card and apply it:
        \${game.cards.map(card => \`- \${card.name}: you \${describe(card)}.\`).join('\\n')}

        \${game.win === 'capture'
            ? 'You win at once by capturing the enemy king.'
            : 'You win by checkmate. Stalemate is a draw. A king is never captured.'}
        \${game.win === 'capture' ? undefined : game.check === 'continues'
            ? 'A move that gives check does not interrupt your series of moves.'
            : 'A move that gives check ends your series of moves at once.'}
        The game is a draw after 300 turns.
    \`;
}
`;

// State machine: the grammar and the validator are those of the Langium examples
// (eclipse-langium/langium, examples/statemachine, MIT License, Copyright 2021 TypeFox GmbH),
// unchanged. The generator to an interactive page was written for this playground.

export const STATEMACHINE_VALIDATOR = `/******************************************************************************
 * Copyright 2021 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { State, Statemachine, StatemachineAstType, Event } from './generated/ast.js';
import type { StatemachineServices } from './statemachine-module.js';
import { MultiMap } from 'langium';

export function registerValidationChecks(services: StatemachineServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.StatemachineValidator;
    const checks: ValidationChecks<StatemachineAstType> = {
        State: validator.checkStateNameStartsWithCapital,
        Statemachine: validator.checkUniqueStatesAndEvents
    };
    registry.register(checks, validator);
}

export class StatemachineValidator {
    /**
     * Checks if the state name starts with a capital letter.
     * @param state the state to check
     * @param accept the acceptor to report errors
     */
    checkStateNameStartsWithCapital(state: State, accept: ValidationAcceptor): void {
        if (state.name) {
            const firstChar = state.name.substring(0, 1);
            if (firstChar.toUpperCase() !== firstChar) {
                accept('warning', 'State name should start with a capital letter.', { node: state, property: 'name' });
            }
        }
    }

    /**
     * Checks if there are duplicate state and event names.
     * @param statemachine the statemachine to check
     * @param accept the acceptor to report errors
     */
    checkUniqueStatesAndEvents(statemachine: Statemachine, accept: ValidationAcceptor): void {
        // check for duplicate state and event names and add them to the map
        const names = new MultiMap<string, State | Event>();
        const allSymbols = [...statemachine.states, ...statemachine.events];
        for (const symbol of allSymbols) {
            names.add(symbol.name, symbol);
        }
        for (const [name, symbols] of names.entriesGroupedByKey()) {
            if (symbols.length > 1) {
                for (const symbol of symbols) {
                    accept('error', \`Duplicate identifier name: \${name}\`, { node: symbol, property: 'name' });
                }
            }
        }
    }
}
`;

export const STATEMACHINE_GENERATOR = `// Model-to-text transformation: a state machine -> an interactive web page.
// The page shows the states, highlights the current one and offers one button per event.
// The page is written to an .html file: the playground shows such a file as a live preview.
import type { State, Statemachine } from '../language/generated/ast.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CompositeGeneratorNode, NL, toString } from 'langium/generate';
import { extractDestinationAndName } from './cli-util.js';

/** What the page needs to run the machine: plain data, without any reference to the AST. */
interface MachineData {
    name: string;
    initial: string;
    events: string[];
    states: { name: string; actions: string[]; transitions: { event: string; target: string }[] }[];
}

function toData(machine: Statemachine): MachineData {
    const describe = (state: State) => ({
        name: state.name,
        actions: state.actions.map(action => action.ref?.name ?? '?'),
        transitions: state.transitions.map(t => ({ event: t.event.ref?.name ?? '?', target: t.state.ref?.name ?? '?' })),
    });
    return {
        name: machine.name,
        initial: machine.init.ref?.name ?? '',
        events: machine.events.map(event => event.name),
        states: machine.states.map(describe),
    };
}

export function generateHtml(machine: Statemachine, filePath: string, destination: string | undefined): string {
    const data = extractDestinationAndName(filePath, destination);
    const generatedFilePath = path.join(data.destination, data.name) + '.html';
    // The machine travels to the page as JSON ("<" is escaped: the text sits inside a script element).
    const json = JSON.stringify(toData(machine)).replace(/</g, '\\\\u003c');

    const page = new CompositeGeneratorNode();
    page.append('<!doctype html>', NL, '<html lang="en">', NL, '<head>', NL);
    page.append('<meta charset="utf-8">', NL, '<title>', machine.name, '</title>', NL);
    page.append('<style>', NL, STYLE, NL, '</style>', NL, '</head>', NL, '<body>', NL);
    page.append('<h1>', machine.name, '</h1>', NL);
    page.append('<div id="states"></div>', NL);
    page.append('<p id="actions"></p>', NL);
    page.append('<div id="events"></div>', NL);
    page.append('<p><button id="reset">Reset</button></p>', NL);
    page.append('<ol id="log"></ol>', NL);
    page.append('<script>', NL, 'var machine = ', json, ';', NL, SCRIPT, NL, '</script>', NL);
    page.append('</body>', NL, '</html>', NL);

    if (!fs.existsSync(data.destination)) {
        fs.mkdirSync(data.destination, { recursive: true });
    }
    fs.writeFileSync(generatedFilePath, toString(page));
    return generatedFilePath;
}

const STYLE = [
    'body { font: 15px system-ui, sans-serif; margin: 16px; color: #1c2330; background: #fff; }',
    'h1 { font-size: 18px; margin: 0 0 12px; }',
    '#states, #events { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }',
    '.state { padding: 8px 14px; border: 2px solid #c9ced8; border-radius: 20px; color: #667085; }',
    '.state.current { border-color: #a4161a; background: #a4161a; color: #fff; font-weight: 600; }',
    'button { font: inherit; padding: 6px 14px; border: 1px solid #c9ced8; border-radius: 6px; background: #f4f5f7; cursor: pointer; }',
    'button:disabled { opacity: 0.4; cursor: default; }',
    '#actions, #log { color: #667085; font-size: 13px; }',
    '@media (prefers-color-scheme: dark) {',
    '  body { color: #e3e6ec; background: #1b1e25; }',
    '  .state { border-color: #3a4050; color: #98a1b2; }',
    '  button { background: #252a33; border-color: #3a4050; color: inherit; }',
    '}',
].join('\\n');

// The program of the page: it interprets the machine. An event that the current state does not
// know is not offered (its button is disabled).
const SCRIPT = [
    'var current = machine.initial, steps = [];',
    'function find(name) { return machine.states.filter(function (s) { return s.name === name; })[0]; }',
    'function target(event) {',
    '  var state = find(current);',
    '  var found = state ? state.transitions.filter(function (t) { return t.event === event; })[0] : undefined;',
    '  return found ? found.target : undefined;',
    '}',
    'function fire(event) {',
    '  var next = target(event);',
    '  if (next === undefined) return;',
    '  steps.push(current + " \\\\u2014 " + event + " \\\\u2192 " + next);',
    '  current = next;',
    '  render();',
    '}',
    'function element(tag, className, text) {',
    '  var e = document.createElement(tag);',
    '  e.className = className; e.textContent = text;',
    '  return e;',
    '}',
    'function render() {',
    '  var states = document.getElementById("states"), events = document.getElementById("events"), log = document.getElementById("log");',
    '  states.textContent = ""; events.textContent = ""; log.textContent = "";',
    '  machine.states.forEach(function (s) { states.appendChild(element("div", s.name === current ? "state current" : "state", s.name)); });',
    '  machine.events.forEach(function (name) {',
    '    var button = element("button", "", name);',
    '    button.disabled = target(name) === undefined;',
    '    button.onclick = function () { fire(name); };',
    '    events.appendChild(button);',
    '  });',
    '  var state = find(current);',
    '  document.getElementById("actions").textContent = state && state.actions.length ? "actions: " + state.actions.join(", ") : "";',
    '  steps.forEach(function (step) { log.appendChild(element("li", "", step)); });',
    '}',
    'document.getElementById("reset").onclick = function () { current = machine.initial; steps = []; render(); };',
    'render();',
].join('\\n');
`;
