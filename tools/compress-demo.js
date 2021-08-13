#!/usr/bin/env node

// compresses demo.html into demo-compressed.html.
// useful as an example of the compression pipeline for demos.
// also produces demo-uncompressed.html for the fair comparison.

import * as fs from 'fs';
import { URL } from 'url';
import csso from 'csso';
import * as terser from 'terser';
import { jsTokens, TYPE_LineTerminatorSequence } from '../js-tokens.js';
import { ArrayBufferPool, defaultSparseSelectors, Packer } from '../index.js';

const html = fs.readFileSync(await resolve('demo.html'), { encoding: 'utf-8' });
const m = html.match(/^(.*?)<style>(.*?)<\/style>(.*?)<script[^>]*>(.*?)<\/script>\s*$/msi);
if (!m) throw 'demo.html does not match the expected template';
const [, preamble, style, body, script] = m;

const roadrollerCode = fs.readFileSync(await resolve('../index.js'), { encoding: 'utf-8' });
const deflateCode = fs.readFileSync(await resolve('../deflate.js'), { encoding: 'utf-8' });
const jsTokensCode = fs.readFileSync(await resolve('../js-tokens.js'), { encoding: 'utf-8' });

let combinedJs = 
    'document.write' +
    makeStringLiteral(
        '<style>' +
        minifyCss(style) +
        '</style>' +
        minifyHtml(body)
    ) +
    ';' +
    await minifyJs(
        stripModule(roadrollerCode) +
        stripModule(deflateCode) +
        stripModule(jsTokensCode) +
        stripModule(script)
    );

const selectors = defaultSparseSelectors();
const packer = new Packer([{ type: 'js', action: 'eval', data: combinedJs }], {
    sparseSelectors: selectors,
    maxMemoryMB: 150,
    arrayBufferPool: new ArrayBufferPool(),
});
//packer.optimizeSparseSelectors();
const { firstLine, secondLine } = packer.makeDecoder();

const uncompressed = minifyHtml(preamble) + '<script>' + combinedJs + '</script>';
const compressed = minifyHtml(preamble) + '<script>' + firstLine + ';' + secondLine + '</script>';
fs.writeFileSync(await resolve('demo-uncompressed.html'), uncompressed, { encoding: 'utf-8' });
fs.writeFileSync(await resolve('demo-compressed.html'), compressed, { encoding: 'utf-8' });

function resolve(path) {
    return new URL(path, import.meta.url);
}

function minifyHtml(html) {
    // replace comments later, so that we can preserve intentional whitespaces around newline
    return html.replace(/^\s+|\s*\n\s*|\s+$/g, '').replace(/<!--.*?-->/g, '');
}

function stripModule(js) {
    let code = '';
    let ignoreTilSemicolon = false;
    let ignoreNextDefault = false;
    for (const token of jsTokens(js)) {
        if (ignoreNextDefault) {
            ignoreNextDefault = false;
            if (token.value === 'default') continue;
        }
        if (ignoreTilSemicolon) {
            ignoreTilSemicolon = (token.value !== ';');
            continue;
        }
        if (token.value === 'import') {
            ignoreTilSemicolon = true;
            continue;
        }
        if (token.value === 'export') {
            ignoreNextDefault = true;
            continue;
        }
        if (token.value === 'const' || token.value === 'let') {
            token.value = 'var';
        }
        code += token.value;
    }
    return code;
}

async function minifyJs(js) {
    const result = await terser.minify({
        'roadroller.js': js,
    }, {
        ecma: 2018,
        toplevel: true,
        mangle: {
            toplevel: true,
        },
        compress: {
            passes: 5,
            unsafe: true,
            pure_getters: true,
        },
    });
    return result.code;
}

function minifyCss(style) {
    return csso.minify(style, { restructure: true }).css;
}

function makeStringLiteral(s) {
    return '`' + s.replace(/[\\`]/g, m => '\\' + m) + '`';
}

