/**
* @description Builds the ScriptTask editor bundle and the licence file for the code it includes.
* Usage: npm install && npm run build   (run in tools/build-editor)
* @license Apache-2.0
*/

"use strict";

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'includes', 'vendor');
const OUT = path.join(OUT_DIR, 'st-codemirror.min.js');

esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'editor.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    legalComments: 'none',
    metafile: true,
    banner: { js: '/* ScriptTask editor: CodeMirror 6 and code themes, MIT licensed (see LICENSE-codemirror). Built by tools/build-editor. */' },
    outfile: OUT
}).then((result) => {
    // Collect the licence of every package that ended up in the bundle
    const packages = new Map();
    Object.keys(result.metafile.inputs).forEach((input) => {
        const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
        if (m == null || packages.has(m[1])) return;
        const dir = path.join(__dirname, 'node_modules', m[1]);
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const licenceFile = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
        let text = licenceFile ? fs.readFileSync(path.join(dir, licenceFile), 'utf8').trim() : '';
        // Some packages declare a licence but don't ship its text; use the text from their source repository (licenses/)
        const repo = /github\.com\/([^/]+)\/([^/.]+)/.exec(JSON.stringify(pkg.repository || ''));
        const fallback = repo ? path.join(__dirname, 'licenses', repo[1] + '-' + repo[2] + '.LICENSE') : null;
        if (!text && fallback && fs.existsSync(fallback)) text = fs.readFileSync(fallback, 'utf8').trim();
        packages.set(m[1], { version: pkg.version, license: pkg.license, text: text });
    });
    let out = 'Third-party code in st-codemirror.min.js\n========================================\n\n';
    [...packages.keys()].sort().forEach((name) => { const p = packages.get(name); out += name + ' ' + p.version + ' (' + p.license + ')\n'; });
    // Print each distinct licence text once, with the packages it covers
    const byText = new Map();
    packages.forEach((p, name) => { const key = p.text || ('(' + p.license + ', no licence file in package)'); if (!byText.has(key)) byText.set(key, []); byText.get(key).push(name); });
    byText.forEach((names, text) => { out += '\n----------------------------------------\n' + names.sort().join(', ') + '\n\n' + text + '\n'; });
    fs.writeFileSync(path.join(OUT_DIR, 'LICENSE-codemirror'), out);
    console.log('Wrote ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB) with ' + packages.size + ' packages');
}).catch((e) => { console.error(e); process.exit(1); });
