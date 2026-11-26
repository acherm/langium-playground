// Builds dist/index.html: one self-contained file (page, styles, editor, and Langium in a worker).
// It can be opened from disk or served by any static host such as GitHub Pages.
import { build } from 'esbuild';
import fs from 'node:fs';

const version = JSON.parse(fs.readFileSync('node_modules/langium/package.json', 'utf8')).version;
const bundle = async entry => (await build({
    entryPoints: [entry], bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2022',
    write: false, legalComments: 'none', define: { __LANGIUM_VERSION__: JSON.stringify(version) },
})).outputFiles[0].text;
// Inside <script>, these two sequences would end or confuse the element.
const inline = js => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const [app, worker] = await Promise.all([bundle('src/main.ts'), bundle('src/worker.ts')]);
const html = fs.readFileSync('src/index.html', 'utf8')
    .replace('/*CSS*/', () => fs.readFileSync('src/style.css', 'utf8'))
    .replace('<!--WORKER-->', () => inline(worker))
    .replace('<!--APP-->', () => inline(app));
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} kB  (Langium ${version})`);
