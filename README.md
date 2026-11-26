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

"Honestly" is the point of this page. It was written after a lab session where the online playground
froze, lost track of errors, or displayed a tree that did not match the text. Three rules follow:

1. **The page never freezes.** Langium runs in a web worker. An analysis that exceeds its time limit
   (10 s for a grammar, 6 s for a program) is abandoned, the worker is replaced, and the page says so.
2. **No stale result.** One analysis at a time, and a result is displayed only if it was computed from
   the text that is in the editors now. When the grammar is invalid, programs are not analysed, and
   the last tree is dimmed and labelled out of date.
3. **Every problem has a place and an origin.** Line, column, and the phase that found it: lexer,
   parser, linker, or the parser generator (left recursion, ambiguous alternatives), reported on the
   rule concerned.

What you get, besides: several programs in tabs, each with an accepted / rejected mark; a hover that
tells whether the lexer read a word as a keyword or as a terminal; completion (Ctrl-Space) of keywords
and reference targets; the tree as JSON; highlighting of a tree node's text; autosave in the browser;
a share link that contains grammar and programs; downloads. Examples: Hello world, Chess,
VideoGenerator, Poll, Chess-Uno.

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
document synchronisation. The page sends the worker one of three plain requests (analyse this grammar,
analyse this program, complete at this offset) and receives plain data.

The services behind are Langium's own, called as functions: `DocumentBuilder` (parse, link, validate),
`Lexer`, `JsonSerializer`, and for completion the `CompletionProvider` of `langium/lsp`. That last
one, and the diagnostics, use the *data types* of LSP (`Diagnostic`, `CompletionItem`): they are
converted to offsets in the text before leaving the worker. So: LSP's vocabulary inside Langium, but
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
- **Automated tests of the Langium side** (`test/analysis.test.ts`, 11 tests, in Node): the examples
  are accepted; errors have the expected line, column and phase; the AST has the expected types,
  values, references and text regions; tokens are classified as the lexer saw them; a program cannot
  resolve a reference into another program; an invalid grammar disables the previous one; completion
  proposes keywords and reference targets.
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
