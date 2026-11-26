// Collects the type declarations that the TypeScript service of the page needs: the standard
// library (ES2022, no DOM), Langium, and the packages its declarations refer to.
// Used by the build (embedded in the page) and by the tests.
import fs from 'node:fs';
import path from 'node:path';

const PACKAGES = ['langium', 'chevrotain', '@chevrotain/types', 'chevrotain-allstar', 'vscode-languageserver',
    'vscode-languageserver-protocol', 'vscode-languageserver-types', 'vscode-jsonrpc', 'vscode-languageserver-textdocument', 'vscode-uri'];

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out); else out.push(full);
    }
    return out;
}

/** Returns { '/lib/lib.es2022.d.ts': '...', '/node_modules/langium/package.json': '...', ... } */
export function collectDeclarations(root = process.cwd()) {
    const files = {};
    // The standard library: lib.es2022.d.ts and everything it references.
    const libDir = path.join(root, 'node_modules/typescript5/lib');
    const todo = ['lib.es2022.d.ts'];
    while (todo.length) {
        const name = todo.pop();
        if (files[`/lib/${name}`]) continue;
        const text = fs.readFileSync(path.join(libDir, name), 'utf8');
        files[`/lib/${name}`] = text;
        for (const m of text.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"/g)) todo.push(`lib.${m[1]}.d.ts`);
    }
    for (const pkg of PACKAGES) {
        const dir = path.join(root, 'node_modules', pkg);
        for (const file of walk(dir)) {
            if (!/\.d\.(ts|mts|cts)$/.test(file) && path.basename(file) !== 'package.json') continue;
            if (/\.d\.ts\.map$/.test(file)) continue;
            let text = fs.readFileSync(file, 'utf8');
            if (path.basename(file) === 'package.json') {
                // Keep only what module resolution reads.
                const { name, version, main, module, types, typings, exports, type } = JSON.parse(text);
                text = JSON.stringify({ name, version, main, module, types, typings, exports, type });
            } else {
                text = text.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
            }
            files['/node_modules/' + pkg + '/' + path.relative(dir, file).split(path.sep).join('/')] = text;
        }
    }
    return files;
}
