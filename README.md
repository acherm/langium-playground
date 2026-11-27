# Langium playground, standalone

**Try it: https://blog.mathieuacher.com/langium-playground/**
· **One-minute tour: https://blog.mathieuacher.com/langium-playground/tour/**

Write a [Langium](https://langium.org/) grammar on the left, programs of your language in the middle,
and see on the right the syntax tree (AST) that Langium builds. Errors are shown where they are, in the
grammar and in the programs.

It is one static page (about 7 MB, 2 MB once compressed by the server), with Langium **4.4.0** and a
TypeScript compiler inside. Nothing to install, no server, no account: the page also works offline,
opened from disk.

**Highlights**

- **A grammar, several programs, the syntax tree**, side by side. Each program is marked accepted or
  rejected; every error has its line, its column and the phase that found it.
- **A validator and a generator in TypeScript**, written as in a Langium project (same imports, same
  interfaces) and executed in the page: the checks show up in the programs, the generated text or
  files in "Output". A language without them gets a **starting file to fill**, written from its
  grammar: one empty check per node type, a generator that lists what the program contains.
- **An IDE for that TypeScript**: completion, types and documentation on hover, type errors, go to
  definition, rename, all against the real declarations of Langium and against the **types of the
  AST**, derived from the grammar and shown in their own tab.
- **Editor support in the grammar and in the programs**: completion, go to definition, rename,
  occurrences, hover, formatting of the grammar.
- **It does not freeze and does not lie**: Langium runs in a web worker with a time limit, and a
  result is shown only if it matches the text on screen.
- **What the validators do not tell**: left recursion and ambiguous alternatives are reported on the
  rule concerned.
- **Nothing is lost**: autosave in the browser, a share link that contains everything, downloads.
- **No server, no LSP protocol, one HTML file**: Langium's services are called directly.
- **A generated web page runs in the page**: the state machine of the Langium showcase, with a
  generator that makes it interactive; and **complete games of chess**, checked by a validator that
  knows the rules and played back on a board, move by move.
- Seven examples, four of them complete (grammar, validator, generator): Hello world, Chess (full
  game), Chess-Uno and State machine. The others come with files to fill.
- 67 automated tests (Langium side, user code, TypeScript service, starting files, the state machine
  and the chess example with their generated pages), and a test of
  the built file with its two workers. The interface itself is tested by hand only.
- Written with Claude Code, in one conversation: see [Credits](#credits) and
  [Open questions](#open-questions).

## The tour

`.../tour/` plays a guided demonstration of about one minute, in eight steps: the grammar of "Chess
(full game)", its validator refusing an illegal game, the types of the syntax tree, the code of its
generator, then the page it generates playing a game back on a board; then the state machine,
Chess-Uno, and a language with files to fill. At each step the relevant piece of code is brought
into view and selected: the check that replays the game, the function that records the positions,
the template that writes the rules. It is not a video: it drives the real page (it loads the examples and presses the same tabs a
visitor would), with a caption for each step and buttons to pause, skip, replay or leave. Nothing is
saved during the tour, so your own work is untouched and comes back when you open the playground.

## What this is not

Let's be clear: Langium is not only the playground. It is all about the framework to build services
around a language: validation, scoping, generators, interpreters, editors... Here, most of this is
missing. This page covers the first steps: a grammar, programs, a syntax tree, and since recently a
validator and a generator that can be plugged in (see below). Scoping, type systems, the command
line, the VS Code extension, the generated and typed AST, a real project with its modules: not here.

## The idea

A grammar is enough to get a working language: Langium can *interpret* a grammar and give, at once,
a lexer, a parser, an AST, cross-reference resolution and completion. So a playground only has to do
three things: run Langium on the grammar, run the resulting language on the programs, and show the
results honestly.

"Honestly" is the point of this page (see the motivation below). Three rules follow:

1. **The page never freezes.** Langium runs in a web worker. An analysis that exceeds its time limit
   (10 s for a grammar, 6 s for a program) is abandoned, the worker is replaced, and the page says so.
2. **No stale result.** One analysis at a time, and a result is displayed only if it was computed from
   the text that is in the editors now. When the grammar is invalid, programs are not analysed, and
   the last tree is dimmed and labelled out of date.
3. **Every problem has a place and an origin.** Line, column, and the phase that found it: lexer,
   parser, linker, or the parser generator (left recursion, ambiguous alternatives), reported on the
   rule concerned.

In both editors, for the grammar as for the programs: completion (Ctrl-Space), go to definition (F12
or Ctrl/Cmd-click), rename of a name and all its uses (F2), marking of the declaration and uses of the
name under the cursor, documentation comments on hover. The grammar can be formatted (Shift-Alt-F).

What you get, besides: several programs in tabs, each with an accepted / rejected mark; a hover that
tells whether the lexer read a word as a keyword or as a terminal; the tree as JSON; highlighting of
a tree node's text; autosave in the browser; a share link that contains everything; downloads.
Examples: Hello world, Chess, Chess (full game), VideoGenerator, Poll, Chess-Uno, State machine.

## A validator and a generator, in TypeScript

Next to the grammar, two more files can be written, in the tabs "Validator" and "Generator". They are
written **as in a Langium project**, with the same imports and the same interfaces, and they are
executed in the page. The validator and the generator of the Langium project template run unchanged
(example "Hello world"); so do those of MiniChuno (example "Chess-Uno").

**Validator.** The file exports `registerValidationChecks(services)` and a class, as usual:

```ts
import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { HelloWorldAstType, Person } from './generated/ast.js';

export function registerValidationChecks(services: HelloWorldServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.HelloWorldValidator;
    const checks: ValidationChecks<HelloWorldAstType> = {
        Person: validator.checkPersonStartsWithCapital
    };
    registry.register(checks, validator);
}

export class HelloWorldValidator {
    checkPersonStartsWithCapital(person: Person, accept: ValidationAcceptor): void { ... }
}
```

Every class the file exports is registered under its name in `services.validation`, which is what
the module of a Langium project does by hand. The errors and warnings of the checks appear in the
programs, with the others.

**Generator.** The file exports a function that receives the root of the AST of a valid program. What
it returns, the files it writes with `fs.writeFileSync`, and what it prints with `console.log` are
shown in the "Output" view, next to the tree. The function is the default export, or the one whose
name starts with `generate` (also: `compile`, `transform`, `interpret`, `run`, `toSomething`). It is
called as the command line of the template calls it: `(model, filePath, destination)`. It runs on
valid programs only. An interpreter is a generator that prints.

**A generated web page is shown running.** When the generator writes an `.html` file (or returns a
page), "Output" shows it live, in a frame isolated from the playground, with its source below. This
is how the example "State machine" gets its view: its generator turns a machine into a page with the
states, the current one highlighted, and one button per event. The grammar, the validator and the
traffic light of that example are those of the
[Langium showcase](https://langium.org/showcase/statemachine/), unchanged.

By default the generator runs at every change, of the program, of the grammar or of its own code.
In "Output", a tick turns this off; the generator then runs only when "Run" is pressed, and the page
says so when what is shown has not been generated from the current program.

**What can be imported:** `langium`, `langium/generate`, `langium/lsp`, `./generated/ast.js` (any path
that ends so), `node:fs` and `node:path` (stand-ins: files are collected, not written), and
`./cli-util.js` for `extractDestinationAndName`. An `import type` of anything is fine. The generator
can also import what the validator file exports (`'../language/x-validator.js'`, any path that ends
in `validator.js`), to share code with it.

**A larger example: "Chess (full game)".** Its files are in
[`examples/chess-full-game/`](examples/chess-full-game/), as real files.

- The *grammar* writes a complete game in long algebraic notation: `e2-e4`, `Ng1-f3`, `d4xe5`,
  `O-O`, `O-O-O`, `e7-e8=Q`, `+`, `#`, numbered turns, players, result. It says how a game is
  written, not whether it is chess.
- The *validator* replays the game on a board. It rejects a move that is not legal (no piece on the
  square, wrong side, a piece that does not move that way, a way that is not free, castling when it
  is not allowed, en passant too late, a missing promotion, a king left in check), and it checks that
  the notation tells the truth (the piece letter, `x`, `+`, `#`, the result). The rules of chess are
  in the second half of the file, independent of Langium.
- The *generator* imports those rules, replays the game, and writes a page: the board, the list of
  moves, and buttons (or the arrow keys) for the previous and the next move.
- Three programs: the Opera Game (Morphy, 1858), a short game with every special move, and a game
  that the grammar accepts and the validator rejects. The small "Chess" example is unchanged.

**Starting a new language.** The button "New language" asks for a name and gives a small grammar that
works (a list of named elements, one of which can refer to another, and the usual terminals), a
program of it, and a validator and a generator to fill. Replace the rules with yours.

**Starting from nothing.** An example that has no validator or generator (Chess, VideoGenerator,
Poll) is loaded with files to fill, and so is a new language. When a tab is empty, "Insert a starting
point" writes the same file, from the grammar on screen: for the validator, the registration function and a class with one empty check
per node type (the first four), each with a commented example on a real property; for the generator,
a function that returns an inventory of the program. Both follow the Langium template, type-check and
run as they are (this is tested for every example grammar).

**An IDE for these two files.** A TypeScript language service runs in a second web worker, with the
real type declarations of Langium:

- completion: the properties of a node (`person.` proposes `name`, `$container`...), the services
  (`services.validation.`), and inside strings the properties `accept` can point to
  (`{ node: person, property: '` proposes `name`) or the severities;
- the type and the documentation of anything on hover;
- type errors, in the list of problems, marked `typescript`;
- go to definition (F12 or Ctrl/Cmd-click), also into the AST types; rename (F2).

**The types of the AST** are in the tab "AST types", read-only: the interfaces, `isX` guards and `X`
constants that `langium generate` writes in `generated/ast.ts`, produced by the same code of Langium.
They follow the grammar as it is edited.

**What differs from a real project, and matters:**

- **Type errors do not prevent the code from running.** In a project, the compiler would stop; here
  the types are erased (by Sucrase) and the code runs, while the type checker reports on the side.
  An error at run time is located (line), on a best effort basis.
- **`./generated/ast.js` is not what runs.** Its types are the generated ones, but when the code
  runs, the guards (`isPerson`) and constants (`Person`) are answered from the interpreted grammar,
  and there is no generated reflection class.
- The file that declares the services (`./hello-world-module.js` in the template) is written for you:
  it declares `XServices`, with every class the validator exports.
- One file each. The generator can import the validator; there are no other files.
- When the validator does not load, programs are not analysed: they could pass wrongly.
- **Code from a share link is not run** until the reader presses "Run the code", after reading it.
  The code runs in the web worker: it has no access to the page nor to what the browser saved, and a
  loop is stopped by the time limit.

## Motivation: issues with the official playground

The [official playground](https://langium.org/playground/) is what this page replaces in our course.
During a lab session where students wrote their first grammar in it, the same problems kept coming
back:

- the program editor crashed or stopped responding, typically while the grammar was being edited;
- errors could not be pinpointed;
- the syntax tree shown was sometimes wrong.

And nothing is saved: a reload goes back to HelloWorld.

Reading its source explains most of it. What follows comes from the files of
`eclipse-langium/langium-website` (`hugo/content/playground/common.ts`, `user-worker.ts`, `utils.ts`,
`hugo/layouts/playground/baseof.html`) as they were on 26 November 2026. It is a reading of the code,
not a reproduction of each failure, and it says nothing against Langium itself, which this page uses
unchanged.

1. **The program editor is hidden whenever the grammar has an error, by design.** An opaque overlay
   ("Your grammar contains errors.") is put over the program panel as soon as the grammar has one
   error diagnostic. A grammar being typed is invalid most of the time.
2. **Each valid change of the grammar destroys and recreates the program editor**: the Monaco editor,
   its language client and a new worker. Before that, the grammar is parsed and a TextMate grammar is
   generated on the page's main thread, so the page stalls meanwhile.
3. **Rebuilds are not serialised.** The 150 ms delay only debounces: a second rebuild can start while
   the first one is still awaiting, and both write the same variable that holds the editor.
4. **A failure in the new worker is never reported.** The page waits for a "started" message, without
   time limit. The worker's message handler is asynchronous and has no `try`/`catch`: if building the
   language throws, the page receives neither a message nor an error event, and "Loading..." stays.
5. **Recent keystrokes can be lost.** The recreated editor is filled from a variable that is updated
   only when the program's language server reports back, not at each keystroke.
6. **Unresolved references are downgraded to warnings**, so a program with a dangling reference looks
   accepted.
7. **Two things are found by no validator**: left recursion (detected when the parser is built) and
   ambiguous alternatives (printed on the console while parsing). No handling of either was found.
8. The editor stack is old: `monaco-editor` 0.44 and `monaco-languageclient` 6.6, unchanged since
   April 2024, while Langium itself is declared as `^4.1.0`.

Each design choice of this page answers one of these points: one worker that is never recreated by an
edit, a strict queue of analyses, a time limit, results checked against the text on screen, an
explicit "out of date" state instead of an overlay, and no second copy of the documents.

## Questions

### How can it be pure JavaScript/TypeScript, with no server?

Because nothing in the chain needs one.

- Langium is a TypeScript library. Its parser engine, Chevrotain, is a JavaScript library too, and it
  builds a parser *at run time* from a description of the grammar: no code generation, no compiler to
  call.
- `createServicesForGrammar` (from `langium/grammar`) takes the text of a grammar and returns the
  services of the language it defines. This is what `langium generate` normally prepares ahead of
  time; here it is done in the browser, each time the grammar changes.
- Langium reads documents through a file-system abstraction. The page gives it an empty one
  (`EmptyFileSystem`) and creates documents in memory, from the text of the editors.
- The bundler (esbuild) puts Langium and the editor into the page. The worker's code is embedded in
  the HTML and started from a Blob, which is why a single file is enough.

What a server usually brings to a language tool is a place to run the language server. Here that
place is a web worker, in the same browser tab. The grammar and the programs never leave the machine.

### Is it still using LSP?

Not the protocol. There is no language client, no JSON-RPC messages, no `initialize` handshake, no
document synchronisation. The page sends the worker plain requests (analyse this grammar, analyse this
program, complete or find the definition at this offset, rename...) and receives plain data.

The services behind are Langium's own, called as functions: `DocumentBuilder` (parse, link, validate),
`Lexer`, `JsonSerializer`, and for the editor features the providers of `langium/lsp`, the very ones a
language server would expose: `CompletionProvider`, `DefinitionProvider`, `DocumentHighlightProvider`,
`RenameProvider`, `HoverProvider`, `Formatter`. They exist twice: for the grammar language (Langium's
own services) and for the language the grammar defines. These providers, and the diagnostics, use the
*data types* of LSP (`Diagnostic`, `CompletionItem`, `WorkspaceEdit`): they are converted to offsets
in the text before leaving the worker. So: LSP's vocabulary inside Langium, but
no LSP between the page and the worker.

Fewer moving parts is the reason. In an LSP setting the editor and the server each hold a copy of the
document and must stay in step; when they do not, the tree no longer matches the text. Here every
request carries the full text, and every answer is checked against the text on screen.

### How was it tested and validated?

- **Probing Langium before designing.** Langium was run on grammars broken on purpose (left recursion,
  direct and indirect; ambiguous alternatives; unknown rule; missing entry rule; terminal matching the
  empty string; malformed regular expression; keyword that hides an identifier; regular expression
  with exponential backtracking) to see what it reports, and where. Two findings shaped the code: left
  recursion is only detected when the parser is built, and ambiguities are only printed on the
  console, while a program is parsed. Both are captured and turned into located problems.
- **Automated tests of the Langium side** (`test/analysis.test.ts`, 18 tests, in Node): the examples
  are accepted; errors have the expected line, column and phase; the AST has the expected types,
  values, references and text regions; tokens are classified as the lexer saw them; a program cannot
  resolve a reference into another program; an invalid grammar disables the previous one; completion
  proposes keywords and reference targets; definition, occurrences and rename follow the
  cross-references, in a program and in the grammar (a renamed rule leaves a grammar that still
  works); formatting changes the layout only.
- **Automated tests of the user code side** (`test/usercode.test.ts`, 14 tests, in Node): the
  validator and the generator of the Langium template, and those of MiniChuno, run unchanged and give
  the expected warnings, files and text; a syntax error, an error while registering the checks, a
  check that throws, a generator that throws are each reported at the right place; an import that
  is not available is said clearly; each program gets its own output.
- **Automated tests of the TypeScript service** (`test/tsservice.test.ts`, 13 tests): the files of
  the Langium template and of MiniChuno, unchanged, have no type error; type errors are found and
  located; completion gives the properties of a node, the services, the properties and severities
  inside strings; hover, go to definition (also into the AST types), rename; the types follow the
  grammar.
- **Automated tests of the starting files** (`test/starter.test.ts`, 9 tests): for every example
  grammar and for a new language, both files type-check and run.
- **Automated tests of the chess example** (`test/chess.test.ts`, 7 tests): the Opera Game is
  accepted move for move, with each capture, check and the checkmate confirmed; so is a game with en
  passant, promotions and castling; 27 situations (a wrong piece letter, a blocked way, castling
  across an attacked square, an ignored check, a false checkmate...) each give the expected message;
  the script of the generated page is run against a stand-in for a document: next, previous, jump
  to a move, keyboard, and the right pieces on the right squares at each step.
- **Automated tests of the state machine example** (`test/statemachine.test.ts`, 6 tests): the
  validator of the Langium examples, unchanged, type-checks and gives its warnings and errors; the
  script of the generated page is run against a stand-in for a document, and the machine behaves
  (current state, events that are possible, steps, reset).
- **A test of the built file** (`test/bundle.test.mjs`): `dist/index.html` contains the page, two
  workers and the type declarations, and no external resource. Both workers, run in a Node sandbox
  that has only what a browser worker has, answer: grammar, program, completion, rename, a validator
  and a generator in TypeScript for the first; type checking, completion and hover for the second.
  This checks that Langium and the TypeScript compiler really work once bundled for a browser.
- **Type checking** of all sources, and a review of the page's logic, which found three defects before
  any use: switching tab could leave the tree of another program on screen; a slow completion could
  kill an analysis under way; a crashed worker was replaced by one that had no grammar.
- **Continuous integration**: type checking and tests run before each deployment.
- **By hand**: the page was used in a browser by its author.

What is *not* tested automatically: the interface itself (editors, tabs, tree, time limits on screen).
Driving a real browser from the tests is the missing piece.

## Compared with the official playground

The official side is read from its source (see above), not measured. "Langium defaults" means the
feature comes from Langium's default language server and was not checked one by one.

**What the official playground has and this page has not**

| | Official | Here |
|---|---|---|
| Editor | Monaco, the editor of VS Code | CodeMirror 6, lighter |
| Other language-server features | whatever else Langium's default server offers (for instance folding, document symbols, find all references) | none of these |
| Formatting a program | not available either (no formatter for a new language) | idem |

**What this page has and the official playground has not**

| | Official | Here |
|---|---|---|
| Validator and generator | none: the grammar only | written in TypeScript as in a Langium project, run in the page, with completion and type checking |
| Types of the AST | not shown | the generated TypeScript declarations, in a tab |
| Several programs | one | tabs, each with an accepted / rejected mark |
| Saving | nothing: a reload resets to HelloWorld | autosave in the browser, file downloads |
| Examples | HelloWorld | five |
| List of problems | squiggles in the editor | list with line, column and phase; click to go there |
| Left recursion, ambiguous alternatives | no handling found | reported on the rule |
| Slow or looping analysis | no time limit | abandoned after 6 to 10 s, worker replaced, message shown |
| Tree and text | properties can be collapsed | hovering a node highlights its text, the cursor marks its node, JSON view, copy |
| Keyword or terminal? | not shown | hover on any word |
| Offline | no | yes: one HTML file |

**What both have, done differently**

| | Official | Here |
|---|---|---|
| Completion, go to definition, rename, hover, grammar formatting | Langium defaults, through LSP | the same Langium providers, called directly |
| Unresolved reference | a **warning** | an **error**, as in a Langium project |
| Invalid grammar | overlay over the program editor, previous language kept behind it | programs not analysed; the editor stays usable; the tree is dimmed and labelled out of date |
| Highlighting of a program | TextMate grammar generated from the grammar | the tokens of the actual lexer |
| Architecture | two language servers in workers, `monaco-languageclient`, program editor recreated at each grammar change | one worker, plain requests that carry the full text |
| Share link | grammar and one program (lz-string) | grammar and all programs (deflate) |
| Syntax tree panel | hidden until asked | always visible |
| Langium version | `^4.1.0` declared | 4.4.0, pinned |

## Build

Node.js 22.6 or later.

    npm ci
    npm test          # Langium side, then the build, then the built file
    npm run build     # writes dist/index.html
    npm run typecheck

`.github/workflows/pages.yml` tests, builds and deploys `dist/` to GitHub Pages at every push on `main`.

| File | Role |
|---|---|
| `src/analysis.ts` | everything that touches Langium: grammar, program, tokens, AST, completion |
| `src/usercode.ts` | runs the validator and the generator: type erasure, importable modules, error location |
| `src/tsservice.ts`, `src/tsworker.ts` | the TypeScript language service for these two files, and its worker |
| `src/starter.ts` | the starting files, written from the grammar |
| `tools/dts.mjs` | collects the type declarations embedded in the page |
| `src/worker.ts` | the web worker around both |
| `src/main.ts` | the page: editors, analysis loop, problem lists, tree, saving and sharing |
| `src/examples.ts` | the examples (most from [acherm/dsl-langium](https://github.com/acherm/dsl-langium)) |
| `examples/chess-full-game/` | the chess example, as real files; `tools/embed-examples.mjs` copies them into `src/examples.generated.ts` |
| `src/index.html`, `src/style.css` | markup and styles |
| `build.mjs` | bundles everything into `dist/index.html` |

## Open questions

This page raises many socio-technical questions. I have no answers.

- **What about the official Langium project?** This page does not retrofit its changes into the
  official playground. It is not even a real fork. I find it a bit sad, and fuzzy for the future of
  open-source projects: when rewriting costs an afternoon, who contributes upstream? Would issues be
  welcome? Agent-written pull requests?
- **On the other hand, if Langium evolves**, we will need agents to integrate the changes here. Who
  maintains such a page, and for how long? Are the tests enough for that?
- **What about LSP?** Here it has disappeared, and it "sounds" fine. Is it? The protocol is gone, but
  the services of Langium that were designed for it are what made this page short to write. What is
  LSP when the editor and the language live in the same process?
- **What is the future of language workbenches?** If the glue (editors, pages, even parsers) becomes
  cheap to write, what remains: the grammar, as a short specification that can be checked? The
  framework, as something agents can rely on?

## Credits

Designed and directed by Mathieu Acher (INSA Rennes) for the course "Domain-Specific Languages".
The code, the tests and this README were written with [Claude Code](https://claude.com/claude-code)
(Claude Fable 5.2, Anthropic), over one conversation: the need, the review of the result and the
decisions are human, the implementation is the model's. The reading of the official playground's
source, in the motivation and the comparison, was also done by Claude.

## Limits

- One grammar file: `import` of another grammar is not supported.
- Besides the validator and the generator, Langium's default behaviour only: no custom scoping, no
  other service can be replaced.
- The validator and the generator are type-checked, but a type error does not stop them (see above).
- The page is large (about 7 MB) because it carries the TypeScript compiler and the declarations.
- This is not the official playground, which is at https://langium.org/playground/.
