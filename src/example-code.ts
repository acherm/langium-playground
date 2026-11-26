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
