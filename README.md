# Langium playground, standalone

**Try it: https://blog.mathieuacher.com/langium-playground/**

Write a [Langium](https://langium.org/) grammar on the left, programs of your language in the middle,
and see on the right the syntax tree (AST) that Langium builds. Errors are shown where they are, in the
grammar and in the programs.

It is one static page, with Langium **4.4.0** inside. Nothing to install, no server, no account: the
page also works offline, opened from disk.

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
tells whether the lexer read a word as a keyword or as a terminal; the tree as JSON; highlighting of a tree node's text; autosave in the browser;
a share link that contains grammar and programs; downloads. Examples: Hello world, Chess,
VideoGenerator, Poll, Chess-Uno.

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
- **A test of the built file** (`test/bundle.test.mjs`): `dist/index.html` contains two inline scripts
  that parse and no external resource, and the worker code embedded in it, run in a Node sandbox,
  answers grammar, program and completion requests. This checks that Langium really works once
  bundled for a browser.
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
| `src/worker.ts` | the web worker around it |
| `src/main.ts` | the page: editors, analysis loop, problem lists, tree, saving and sharing |
| `src/examples.ts` | the examples (most from [acherm/dsl-langium](https://github.com/acherm/dsl-langium)) |
| `src/index.html`, `src/style.css` | markup and styles |
| `build.mjs` | bundles everything into `dist/index.html` |

## Limits

- One grammar file: `import` of another grammar is not supported.
- Langium's default behaviour only: no custom validator, scoping or generator.
- This is not the official playground, which is at https://langium.org/playground/.
