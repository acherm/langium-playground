// Builds dist/index.html: one self-contained file (page, styles, editors, Langium in a worker, and
// a TypeScript service with its type declarations in a second worker).
// It can be opened from disk or served by any static host such as GitHub Pages.
import { build } from 'esbuild';
import fs from 'node:fs';
import { collectDeclarations } from './tools/dts.mjs';

const version = JSON.parse(fs.readFileSync('node_modules/langium/package.json', 'utf8')).version;
const bundle = async entry => (await build({
    entryPoints: [entry], bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2022',
    write: false, legalComments: 'none', define: { __LANGIUM_VERSION__: JSON.stringify(version) }, logLevel: 'error',
    // The TypeScript compiler refers to Node modules that it only uses when it runs in Node.
    external: ['fs', 'path', 'os', 'crypto', 'inspector', 'perf_hooks', 'module', 'url', 'source-map-support'],
})).outputFiles[0].text;
// Inside <script>, these two sequences would end or confuse the element.
const inline = js => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
// JSON inside <script>: no "<" at all.
const inlineJson = value => JSON.stringify(value).replace(/</g, '\\u003c');

const [app, worker, tsWorker] = await Promise.all([bundle('src/main.ts'), bundle('src/worker.ts'), bundle('src/tsworker.ts')]);
const html = fs.readFileSync('src/index.html', 'utf8')
    .replace('/*CSS*/', () => fs.readFileSync('src/style.css', 'utf8'))
    .replace('<!--WORKER-->', () => inline(worker))
    .replace('<!--TSWORKER-->', () => inline(tsWorker))
    .replace('<!--TSLIBS-->', () => inlineJson(collectDeclarations()))
    .replace('<!--APP-->', () => inline(app));
fs.mkdirSync('dist/tour', { recursive: true });
fs.writeFileSync('dist/index.html', html);
// .../tour/ opens the page in tour mode (a one-minute guided demonstration, see the end of src/main.ts).
fs.writeFileSync('dist/tour/index.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Langium playground: the tour</title>
<meta http-equiv="refresh" content="0; url=../index.html?tour">
</head>
<body>
<p>The tour is starting. If nothing happens, <a href="../index.html?tour">open it here</a>.</p>
</body>
</html>
`);
const kB = text => `${(text.length / 1024).toFixed(0)} kB`;
console.log(`dist/index.html  ${kB(html)}  (Langium ${version}; page ${kB(app)}, Langium worker ${kB(worker)}, TypeScript worker ${kB(tsWorker)})`);
