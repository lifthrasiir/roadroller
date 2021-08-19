#!/usr/bin/env node

import * as fs from 'fs';
import * as process from 'process';
import { ArrayBufferPool, Packer, defaultSparseSelectors } from './index.js';
import { estimateDeflatedSize } from './deflate.js';

let VERSION = 'unknown';
try {
    VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), { encoding: 'utf-8' })).version;
} catch (e) {
}

function usage() {
    console.warn(`\
     ____                                                     ___
     /    )                   /              /  /            |   |
    /___ /    __    __    __ /  )__    __   /  /   __   )__  |_JS|
   /    |   /   ) /   ) /   /  /   ) /   ) /  /  /___) /   )
__/_____|__(___/_(___(_(___/__/_____(___/_/__/__(___ _/______${VERSION}__

Usage: roadroller [OUTPUTOPTIONS] [INPUTOPTIONS] [--] INPUT ...

Input options: (only affects the next input path)
INPUT
  The input path. Can be given multiple times but only one is supported
  at the moment. Can be "-" for stdin.
--
  Can be followed by input options to signal that the next argument is
  always an input path even if it starts with "-".
  NOTE: If there are multiple input paths starting with "-"
  there should be multiple "--" for each input.
-t|--type TYPE
  Sets the input type. Inferred from the file extension if omitted.
    js              Valid JavaScript code (UTF-8) [Default for .js]
    text            Human-readable text (UTF-8)
-a|--action ACTION
  Sets the input action. Inferred from the input type if omitted.
    eval            Evaluates as JavaScript code [Default for -t js]
    write           Writes to document

Output options:
-o|--output-file OUTPUT [Default: -]
  The output path. Can be "-" for stdout.
-O|--optimize EFFORTS [Default: 0]
  Tries to tune parameters for this input.
    0               Use the baseline parameters.
    1               Tries to optimize via simulated annealing.
-M|--max-memory MEGABYTES [Default: 150]
  Configures the maximum memory usage. The actual usage might be lower.
-S|--selectors xNUMCONTEXTS [Default: 12]
  Sets the maximum number of contexts used, prefixed by a literal "x".
  Smaller number can be used to finetune the memory usage.
  Larger number only affects the optimization process.
-S|--selectors SELECTOR,SELECTOR... [Default: ${defaultSparseSelectors()}]
  Sets the explicit contexts to be used. See the README for details.
  The optimization prints the best parameters found at the end,
  so that you can copy and paste them for later uses.

Other options:
-q|--silent
  Suppresses any diagnostic messages.
-h|--help
  Prints this message.
-V|--version
  Prints the version.

Please see https://github.com/lifthrasiir/roadroller/ for more information.`);
}

function readToString(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    })
}

const inputs = [];
let currentInput = {};
const options = {
    arrayBufferPool: new ArrayBufferPool(),
};
let optimize;
let outputPath;
let nextIsArg = false;
let silent = false;

for (let i = 2; i < process.argv.length; ++i) {
    const opt = process.argv[i];
    if (nextIsArg || opt === '-' || !opt.startsWith('-')) {
        nextIsArg = false;
        try {
            if (opt === '-') {
                currentInput.data = await readToString(process.stdin);
            } else {
                currentInput.data = fs.readFileSync(opt, { encoding: 'utf-8' });
            }
        } catch (e) {
            throw `cannot read from the input path ${opt}`;
        }
        if (currentInput.type === undefined) {
            if (opt.endsWith('.js')) {
                currentInput.type = 'js';
            } else {
                throw `cannot infer the input type for ${opt}`;
            }
        }
        if (currentInput.action === undefined) {
            if (currentInput.type === 'js') {
                currentInput.action = 'eval';
            } else {
                throw `cannot infer the input action for ${opt}`;
            }
        }
        inputs.push(currentInput);
        currentInput = {};
        continue;
    }

    const getArg = m => {
        if (m[1]) return m[1];
        if (++i >= process.argv.length) throw `invalid ${opt} argument`;
        return process.argv[i];
    };
    let m;
    if (opt.match(/^(?:-h|--help)$/)) {
        usage();
        process.exit(0);
    } else if (opt.match(/^(?:-V|--version)$/)) {
        console.log(`Roadroller ${VERSION}`);
        process.exit(0);
    } else if (opt.match(/^(?:-q|--silent)$/)) {
        silent = true;
    } else if (m = opt.match(/^(?:-t|--type)=?(.*)$/)) {
        if (currentInput.type !== undefined) throw 'duplicate --type arguments';
        currentInput.type = getArg(m);
    } else if (m = opt.match(/^(?:-a|--action)=?(.*)$/)) {
        if (currentInput.action !== undefined) throw 'duplicate --action arguments';
        currentInput.action = getArg(m);
    } else if (m = opt.match(/^(?:-o|--output-file)=?(.*)$/)) {
        if (outputPath !== undefined) throw 'duplicate --output-file arguments';
        outputPath = getArg(m);
    } else if (m = opt.match(/^(?:-O|--optimize)=?(.*)$/)) {
        if (optimize !== undefined) throw 'duplicate --optimize arguments';
        optimize = Number(getArg(m));
        if (optimize !== 0 && optimize !== 1) throw 'invalid --optimize argument';
    } else if (m = opt.match(/^(?:-M|--max-memory)=?(.*)$/)) {
        if (options.maxMemoryMB !== undefined) throw 'duplicate --max-memory arguments';
        options.maxMemoryMB = parseInt(getArg(m), 10);
        if (!(10 <= options.maxMemoryMB && options.maxMemoryMB <= 1024)) throw 'invalid --max-memory argument';
    } else if (m = opt.match(/^(?:-S|--selectors)=?(.*)$/)) {
        if (options.sparseSelectors !== undefined) throw 'duplicate --max-memory arguments';
        const arg = getArg(m);
        let selectors;
        if (arg.match(/^x[0-9]+$/)) {
            const numContexts = parseInt(arg.substr(1), 10);
            if (numContexts > 64) throw 'too many selectors in --selectors argument';
            selectors = defaultSparseSelectors(numContexts);
        } else {
            selectors = arg.split(/,/g).map(v => parseInt(v, 10)).sort((a, b) => a - b);
            if (selectors.length > 64) throw 'too many selectors in --selectors argument';
            if (selectors.some(sel => sel !== sel || sel < 0)) throw 'invalid selector in --selectors argument';
            if (selectors.find((sel, i) => selectors[i-1] === sel)) throw 'duplicate selector in --selectors argument';
        }
        options.sparseSelectors = selectors;
    } else if (opt == '--') {
        nextIsArg = true;
    } else {
        throw `unknown option ${opt}`;
    }
}

if (Object.keys(currentInput).length > 0) {
    throw 'the last input path is missing';
}
if (inputs.length === 0) {
    usage();
    process.exit(1);
}
if (optimize === undefined) optimize = 0;
if (outputPath === undefined) outputPath = '-';

let packer = new Packer(inputs, options);

if (optimize) {
    const { firstLineLengthInBytes, secondLine } = packer.makeDecoder();
    const origSize = firstLineLengthInBytes + estimateDeflatedSize(secondLine);
    if (!silent) console.warn(`original size:`, origSize);

    // the js input can be freely changed to the text, see if it fares better
    let preferText = false;
    if (inputs[0].type === 'js') {
        const inputs2 = JSON.parse(JSON.stringify(inputs));
        inputs2[0].type = 'text';
        const textPacker = new Packer(inputs2, options);
        const { firstLineLengthInBytes, secondLine } = textPacker.makeDecoder();
        const textSize = firstLineLengthInBytes + estimateDeflatedSize(secondLine);

        if (textSize < origSize) {
            if (!silent) console.warn(`switch the JS input to the text:`, textSize);
            packer = textPacker;
            preferText = true;
        }
    }

    const result = await packer.optimizeSparseSelectors(info => {
        if (silent) return;
        console.warn(
            `(T=${info.temperature.toFixed(4)}) trying ${JSON.stringify(info.current)}:`,
            info.currentSize, info.bestUpdated ? '<-' : info.currentRejected ? 'x' : '');
    });
    if (!silent) {
        console.warn(
            `search done in ${(result.elapsedMsecs / 1000).toFixed(1)}s, ` +
            `use \`${preferText ? '-t text ' : ''}-S ${result.best.join(',')}\` to replicate:`,
            result.bestSize);
    }
}

const { firstLine, firstLineLengthInBytes, secondLine } = packer.makeDecoder();
const output = firstLine + '\n' + secondLine;
const origLength = inputs.reduce((acc, { data } ) => {
    return acc + (Array.isArray(data) ? data.length : unescape(encodeURIComponent(data)).length);
}, 0);
const compressedLength = firstLineLengthInBytes + estimateDeflatedSize(secondLine);
const ratio = origLength > 0 ? 100 - compressedLength / origLength * 100 : -Infinity;
if (!optimize && !silent) {
    console.warn(`compressed ${origLength}B into ${compressedLength}B (estimated, ${Math.abs(ratio).toFixed(2)}% ${ratio > 0 ? 'smaller' : 'larger'}).`);
}
if (outputPath === '-') {
    console.log(output); // this includes a trailing newline, use the file output to get rid of it
} else {
    fs.writeFileSync(outputPath, output, { encoding: 'utf-8' });
}

