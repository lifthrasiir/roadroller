#!/usr/bin/env node

// compresses demo.html into demo-compressed.html.
// useful as an example of the compression pipeline for demos.
// also produces demo-uncompressed.html for the fair comparison.

import * as fs from 'fs';
import { URL } from 'url';
import csso from 'csso';
import * as terser from 'terser';
import { jsTokens, TYPE_RegularExpressionLiteral, TYPE_LineTerminatorSequence } from '../js-tokens.mjs';
import { ArrayBufferPool, defaultSparseSelectors, Packer } from '../index.mjs';

const html = fs.readFileSync(await resolve('demo.html'), { encoding: 'utf-8' });
const m = html.match(/^(.*?)<style>(.*?)<\/style>(.*?)<script[^>]*>(.*?)<\/script>\s*$/msi);
if (!m) throw 'demo.html does not match the expected template';
const [, preamble, style, body, script] = m;

const roadrollerCode = fs.readFileSync(await resolve('../index.mjs'), { encoding: 'utf-8' });
const wasmCode = fs.readFileSync(await resolve('../wasm.mjs'), { encoding: 'utf-8' });
const deflateCode = fs.readFileSync(await resolve('../deflate.mjs'), { encoding: 'utf-8' });
const jsTokensCode = fs.readFileSync(await resolve('../js-tokens.mjs'), { encoding: 'utf-8' });

const { code, vars } = await minifyJs(
    stripModule(deflateCode) +
    stripModule(jsTokensCode) +
    stripModule(wasmCode) +
    stripModule(roadrollerCode) +
    stripModule(script, true)
);

const ID_PATTERN = /(?<![a-z$\\])[ic]?\\*\$[a-zA-Z0-9_]+/g;

const map = assignIds(html, vars);
const combinedJs =
    'document.write' +
    remapIds(map, makeStringLiteral(
        '<style>' +
        minifyCss(style) +
        '</style>' +
        minifyHtml(body)
    )) +
    ';' +
    remapIdsInJs(map, code);

const selectors = defaultSparseSelectors();
const packer = new Packer([{ type: 'js', action: 'eval', data: combinedJs }], {
    sparseSelectors: selectors,
    maxMemoryMB: 150,
    arrayBufferPool: new ArrayBufferPool(),
});
if (false) { // doesn't improve much
    const result = await packer.optimize(info => {
        console.warn(`${info.bestSize} ${info.currentSize} ${JSON.stringify(info.current)}`);
    });
    console.warn(`${result.bestSize} - ${JSON.stringify(result.best)}`);
}
const { firstLine, secondLine } = packer.makeDecoder();

const uncompressed = minifyHtml(preamble) + '<script>' + combinedJs + '</script>';
const compressed = minifyHtml(preamble) + '<script>' + firstLine + secondLine + '</script>';
fs.writeFileSync(await resolve('demo-uncompressed.html'), uncompressed, { encoding: 'utf-8' });
fs.writeFileSync(await resolve('demo-compressed.html'), compressed, { encoding: 'utf-8' });

function resolve(path) {
    return new URL(path, import.meta.url);
}

function minifyHtml(html) {
    // replace comments later, so that we can preserve intentional whitespaces around newline
    return html.replace(/^\s+|\s*\n\s*|\s+$/g, '').replace(/<!--.*?-->/g, '');
}

function stripModule(js, main) {
    const SAFE_NAMES = [
        'action',
        'data',
        'precision',
        'type',
    ];
    const LIB_SAFE_NAMES = [
        'abbr',
        'closed',
        'code',
        'finished',
        'options',
        'quote',
        'release',
        'tag',
        'update',
        'value',
    ];

    let code = '';
    let ignoreTilSemicolon = false;
    let ignoreNextDefault = false;
    const safeNames = new Set(main ? SAFE_NAMES : SAFE_NAMES.concat(LIB_SAFE_NAMES));
    for (const token of jsTokens(js)) {
        if (ignoreNextDefault) {
            ignoreNextDefault = false;
            if (token.value === 'default') continue;
        }
        if (ignoreTilSemicolon === 'unless-paren' && token.value === '(') {
            ignoreTilSemicolon = false;
        } else if (ignoreTilSemicolon) {
            ignoreTilSemicolon = (token.value !== ';');
            continue;
        }
        if (token.value === 'import') {
            ignoreTilSemicolon = 'unless-paren'; // retain `import(...)`
            continue;
        }
        if (token.value === 'export') {
            ignoreNextDefault = true;
            continue;
        }
        if (token.value === 'const' || token.value === 'let') {
            // while this is generally not safe, the entire code base is
            // intentionally written so that this is indeed safe
            token.value = 'var';
        } else if (safeNames.has(token.value)) {
            // rename properties which are also used as built-in DOM properties
            // so Terser refuses to mangle them.
            token.value += '_';
        }
        code += token.value;
    }
    return code;
}

async function minifyJs(js) {
    const nameCache = {};
    const { code } = await terser.minify({
        'roadroller.js': js,
    }, {
        ecma: 2018,
        toplevel: true,
        mangle: {
            toplevel: true,
            properties: {
                regex: /^[^$]+$/,
                keep_quoted: 'strict',
            },
        },
        compress: {
            passes: 5,
            unsafe: true,
            pure_getters: true,
        },
        nameCache,
    });
    const vars = Object.keys(nameCache.vars.props).map(k => nameCache.vars.props[k]);
    return { code, vars };
}

function assignIds(html, vars) {
    const ids = [...html.matchAll(ID_PATTERN)].map(([id]) => id.replace(/\\/g, ''));
    const uniqIds = [...new Set(ids)].sort();

    const ALPHABET = '_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const DIGIT = '0123456789';
    const assignments = [];
    done: for (const c1 of ALPHABET) {
        for (const c2 of ALPHABET + DIGIT) {
            if (!vars.includes(c1 + c2)) {
                assignments.push(c1 + c2);
                if (assignments.length >= uniqIds.length) break done;
            }
        }
    }
    return new Map(uniqIds.map((id, i) => [id, assignments[i]]));
}

function remapIds(map, s) {
    return s.replace(ID_PATTERN, id => {
        id = id.replace(/\\/g, '');
        return map.get(id);
    });
}

function remapIdsInJs(map, s) {
    const tokens = [];
    for (const token of jsTokens(s)) {
        if (token.type !== TYPE_RegularExpressionLiteral) {
            token.value = remapIds(map, token.value);
        }
        tokens.push(token.value);
    }
    return tokens.join('');
}

function minifyCss(style) {
    return csso.minify(style, { restructure: true }).css;
}

function makeStringLiteral(s) {
    return '`' + s.replace(/[\\`]/g, m => '\\' + m) + '`';
}

