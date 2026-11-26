// Files to start from, for a language that has no validator or no generator yet. They follow the
// Langium project template (same structure, same imports) and are filled with the names of the
// grammar: its node types and their properties. Pure functions: tested in test/starter.test.ts,
// where each starter must type-check and run for every example grammar.
import type { AstTypeInfo } from './analysis';

export interface GrammarInfo { name: string; entry: string; types: AstTypeInfo[] }

const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
    'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield', 'await', 'interface', 'package',
    'private', 'protected', 'public', 'implements', 'accept', 'type']);

/** `DeckEntry` -> `deckEntry`: the name of a variable that holds such a node. */
function variable(type: string): string {
    const v = type.charAt(0).toLowerCase() + type.slice(1);
    return RESERVED.has(v) ? `${v}Node` : v;
}

/** `HelloWorld` -> `hello-world`: how the template names the files of a language. */
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

function normalise(info: GrammarInfo) {
    const name = info.name || 'My';
    const entry = info.entry || info.types[0]?.name || 'Model';
    const types = info.types.length ? info.types : [{ name: entry, properties: [] }];
    return { name, entry, types };
}

/** `my dsl`, `my-dsl`, `2 robots` -> `MyDsl`, `MyDsl`, `Robots`: a name Langium accepts for a grammar. */
export function languageName(raw: string): string {
    const words = raw.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/^[0-9]+/, '');
    return name || 'MyDsl';
}

/**
 * A new language to start from: a small grammar that works (a list of named things, one of which
 * can refer to another), with the usual terminals, and a program of that language.
 */
export function newLanguage(raw: string): { name: string; grammar: string; program: { name: string; text: string } } {
    const name = languageName(raw);
    const grammar = `grammar ${name}

// A grammar to start from: replace the rules below with those of your language.
// An entry rule, then one rule per concept. \`name=ID\` stores what is read in a property;
// \`+=\` adds to a list; \`[Element:ID]\` is a reference to an Element, by its name.

entry Model:
    elements+=Element*;

Element:
    'element' name=ID ('after' previous=[Element:ID])?;

hidden terminal WS: /\\s+/;
terminal ID: /[_a-zA-Z][\\w_]*/;
terminal INT returns number: /[0-9]+/;
terminal STRING: /"(\\\\.|[^"\\\\])*"|'(\\\\.|[^'\\\\])*'/;

hidden terminal ML_COMMENT: /\\/\\*[\\s\\S]*?\\*\\//;
hidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;
`;
    const text = `// A program of ${name}: replace it with yours.
element first
element second after first
`;
    return { name, grammar, program: { name: `example.${name.toLowerCase()}`, text } };
}

/** A validator with one empty check per node type (the first ones), ready to be filled. */
export function validatorStarter(info: GrammarInfo, maxChecks = 4): string {
    const { name, types } = normalise(info);
    const checked = types.slice(0, maxChecks);
    return `import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { ${[`${name}AstType`, ...checked.map(t => t.name)].join(', ')} } from './generated/ast.js';
import type { ${name}Services } from './${kebab(name)}-module.js';

/**
 * Register custom validation checks: for each type of node, the method that checks it.
 * The types of the nodes are in the tab "AST types".
 */
export function registerValidationChecks(services: ${name}Services) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.${name}Validator;
    const checks: ValidationChecks<${name}AstType> = {
${checked.map(t => `        ${t.name}: validator.check${t.name}`).join(',\n')}
    };
    registry.register(checks, validator);
}

/**
 * What the grammar cannot say. Each method receives a node and reports with \`accept\`:
 *     accept('error' | 'warning' | 'info' | 'hint', message, { node, property })
 */
export class ${name}Validator {
${checked.map(t => {
        const v = variable(t.name), p = t.properties[0]?.name;
        return `
    check${t.name}(${v}: ${t.name}, accept: ValidationAcceptor): void {
        // TODO: what must hold for every ${t.name}, that the grammar cannot say?
${p ? `        // if (${v}.${p} ...) {
        //     accept('warning', 'Explain what is wrong.', { node: ${v}, property: '${p}' });
        // }` : `        // accept('warning', 'Explain what is wrong.', { node: ${v} });`}
    }`;
    }).join('\n')}
}
`;
}

/** A generator that returns an inventory of the program, ready to be replaced. */
export function generatorStarter(info: GrammarInfo): string {
    const { entry, types } = normalise(info);
    const root = variable(entry);
    const lists = (types.find(t => t.name === entry)?.properties ?? []).filter(p => p.array);
    return `import type { ${entry} } from '../language/generated/ast.js';
import { expandToString } from 'langium/generate';

/**
 * Receives the root of the AST of a valid program. What it returns is shown in "Output".
 * It can also write files (\`fs.writeFileSync\`, from 'node:fs') and print (\`console.log\`).
 * The types of the nodes are in the tab "AST types".
 */
export function generate(${root}: ${entry}): string {
    // TODO: produce something from the program. To begin with, what it contains:
    return expandToString\`
        A \${${root}.$type}${lists.map(p => `
        \${${root}.${p.name}.length} ${p.name}`).join('')}
    \`;
}
`;
}
