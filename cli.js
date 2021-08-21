#!/usr/bin/env node

import * as fs from 'fs';
import * as process from 'process';
import { ArrayBufferPool, Packer, defaultSparseSelectors } from './index.js';

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
                    Also prints the best parameters unless -q is given.
-M|--max-memory MEGABYTES [Range: 10..1024, Default: 150]
  Configures the maximum memory usage.
  The actual usage might be lower. Use -v to print the actual usage.
-S|--selectors xNUMCONTEXTS [Range: 1..64, Default: 12]
  Sets the maximum number of contexts used, prefixed by a literal "x".
  For 13+ contexts additional contexts are randomly picked.
  Can be used for finer (linear) tuning of the memory usage.
-S|--selectors SELECTOR,SELECTOR... [Default: ${defaultSparseSelectors()}]
  Sets the explicit contexts to be used.
  Each number designates bytes to be used as a context for that model;
  if K-th (K>0) lowest bit is set the context uses the K-th-to-last byte,
  so for example 5 = 101 (binary) designates a (0,2) sparse context model.
-Zab|--num-abbreviations NUM [Range: 0..64, Default: 64]
  Limit the number of name abbreviations to NUM.
  Ignored if there are less than NUM feasible abbreviations.
-Zco|--context-bits BITS [Range: 1..24+, Default: derived]
  Sets the size of each context model, as opposed to the total size (-M).
  The maximum can range from 24 to 30 depending on the number of contexts.
-Zlr|--learning-rate RATE [Range: 1..2^53, Default: 256]
  Configures the learning rate of context mixer; smaller adapts faster.
-Zmc|--model-max-count COUNT [Range: 1..32767, Default: 63]
  Configures the adaptation speed of context models.
  Context models adapt fastest when the context is first seen,
  but become slower each subsequent occurrence of the context.
  This option configures how slowest the adaptation can be;
  smaller COUNT is better for quickly varying (non-stationary) inputs.
-Zpr|--precision BITS [Range: 1..21, Default: 16]
  Sets the precision of internal fixed point representations.

Other options:
-q|--silent
  Suppresses any diagnostic messages.
-v|--verbose
  Prints more information whenever appropriate. Can be repeated.
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

async function parseArgs(args) {
    const inputs = [];
    let currentInput = {};
    const options = {
        arrayBufferPool: new ArrayBufferPool(),
    };
    let optimize;
    let outputPath;
    let nextIsArg = false;
    let verbose = 0; // -1: -q, 0: default, 1: -v, 2: -vv, ...

    while (args.length > 0) {
        const opt = args.shift();
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

        const matchOpt = (long, short) =>
            opt === '--' + long || (short && opt === '-' + short);
        const matchOptArg = (long, short) =>
            opt.match(new RegExp(`^(?:--${long}|(?:--${long}=${short ? `|-${short}=?` : ''})(.*))$`));
        const getArg = m => {
            if (m[1]) return m[1];
            if (args.length === 0) throw `invalid ${opt} argument`;
            return args.shift();
        };

        let m;
        if (matchOpt('help', 'h')) {
            return { command: 'usage' };
        } else if (matchOpt('version', 'V')) {
            return { command: 'version' };
        } else if (matchOpt('silent', 'q')) {
            if (verbose > 0) throw '-q and -v cannot be used together';
            verbose = -1;
        } else if (m = opt.match(/^(?:--verbose|-(v+))$/)) {
            if (verbose < 0) throw '-v and -q cannot be used together';
            verbose += (m[1] || 'v').length;
        } else if (m = matchOptArg('type', 't')) {
            if (currentInput.type !== undefined) throw 'duplicate --type arguments';
            currentInput.type = getArg(m);
        } else if (m = matchOptArg('action', 'a')) {
            if (currentInput.action !== undefined) throw 'duplicate --action arguments';
            currentInput.action = getArg(m);
        } else if (m = matchOptArg('output-file', 'o')) {
            if (outputPath !== undefined) throw 'duplicate --output-file arguments';
            outputPath = getArg(m);
        } else if (m = matchOptArg('optimize', 'O')) {
            if (optimize !== undefined) throw 'duplicate --optimize arguments';
            optimize = Number(getArg(m));
            if (optimize !== 0 && optimize !== 1) throw 'invalid --optimize argument';
        } else if (m = matchOptArg('max-memory', 'M')) {
            if (options.maxMemoryMB !== undefined) throw 'duplicate --max-memory arguments';
            if (options.maxMemoryMB !== undefined) throw '--max-memory cannot be used with --context-bits';
            options.maxMemoryMB = parseInt(getArg(m), 10);
            if (!(10 <= options.maxMemoryMB && options.maxMemoryMB <= 1024)) throw 'invalid --max-memory argument';
        } else if (m = matchOptArg('selectors', 'S')) {
            if (options.sparseSelectors !== undefined) throw 'duplicate --max-memory arguments';
            const arg = getArg(m);
            let selectors;
            if (arg.match(/^x[0-9]+$/)) {
                const numContexts = parseInt(arg.substr(1), 10);
                if (numContexts < 1) throw 'no selectors in --selectors argument';
                if (numContexts > 64) throw 'too many selectors in --selectors argument';
                selectors = defaultSparseSelectors(numContexts);
            } else {
                selectors = arg.split(/,/g).map(v => parseInt(v, 10)).sort((a, b) => a - b);
                if (selectors.length < 1) throw 'no selectors in --selectors argument';
                if (selectors.length > 64) throw 'too many selectors in --selectors argument';
                if (selectors.some(sel => sel !== sel || sel < 0 || sel >= 0x80000000)) {
                    throw 'invalid selector in --selectors argument';
                }
                if (selectors.find((sel, i) => selectors[i-1] === sel)) {
                    throw 'duplicate selector in --selectors argument';
                }
            }
            options.sparseSelectors = selectors;
        } else if (m = matchOptArg('num-abbreviations', 'Zab')) {
            if (options.numAbbreviations !== undefined) throw 'duplicate --num-abbreviations arguments';
            options.numAbbreviations = parseInt(getArg(m), 10);
            if (options.numAbbreviations < 0 || options.numAbbreviations > 64) {
                throw 'invalid --num-abbreviations argument';
            }
        } else if (m = matchOptArg('context-bits', 'Zco')) {
            if (options.contextBits !== undefined) throw 'duplicate --context-bits arguments';
            if (options.maxMemoryMB !== undefined) throw '--context-bits cannot be used with --max-memory';
            options.contextBits = parseInt(getArg(m), 10);
            if (options.contextBits < 1 || options.contextBits > 30) throw 'invalid --context-bits argument';
            // additional check below
        } else if (m = matchOptArg('learning-rate', 'Zlr')) {
            if (options.learningRateDenom !== undefined) throw 'duplicate --learning-rate arguments';
            options.learningRateDenom = parseInt(getArg(m), 10);
            if (options.learningRateDenom < 1 || options.learningRateDenom > 2**53) {
                throw 'invalid --learning-rate argument';
            }
        } else if (m = matchOptArg('model-max-count', 'Zmc')) {
            if (options.modelMaxCount !== undefined) throw 'duplicate --model-max-count arguments';
            options.modelMaxCount = parseInt(getArg(m), 10);
            if (options.modelMaxCount < 1 || options.modelMaxCount > 32767) {
                throw 'invalid --model-max-count argument';
            }
        } else if (m = matchOptArg('precision', 'Zpr')) {
            if (options.precision !== undefined) throw 'duplicate --precision arguments';
            options.precision = parseInt(getArg(m), 10);
            if (options.precision < 1 || options.precision > 28) throw 'invalid --precision argument';
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
        return { command: 'default' };
    }
    if (optimize === undefined) optimize = 0;
    if (outputPath === undefined) outputPath = '-';

    // this implies that -Zco24 unconditionally works but -Zco25..30 may not work depending on -Sx
    const numSelectors = options.sparseSelectors ? options.sparseSelectors.length : 12;
    if (numSelectors * (1 << options.contextBits) > (1 << 30)) throw 'invalid --context-bits argument';

    return { command: 'compress', inputs, options, optimize, outputPath, verbose };
}

async function compress({ inputs, options, optimize, outputPath, verbose }) {
    let packer = new Packer(inputs, options);

    if (verbose >= 1) {
        console.warn(
            `Actual memory usage: ${packer.memoryUsageMB < 1 ? '< 1' : packer.memoryUsageMB} MB` +
            (options.contextBits ? '' : ` (out of ${options.maxMemoryMB || 150} MB)`));
    }

    if (optimize) {
        // the js input can be freely changed to the text, see if it fares better
        let preferText = false;
        if (inputs[0].type === 'js') {
            const origSize = packer.makeDecoder().estimateLength();
            inputs[0].type = 'text';
            const textPacker = new Packer(inputs, options);
            const textSize = textPacker.makeDecoder().estimateLength();
            inputs[0].type = 'js';

            if (textSize < origSize) {
                if (verbose >= 0) console.warn(`switch the JS input to the text:`, textSize);
                packer = textPacker;
                preferText = true;
            }
        }

        const result = await packer.optimizeSparseSelectors(info => {
            if (verbose < 0) return;
            console.warn(
                (info.temperature > 1 ? '(baseline)' : `(T=${info.temperature.toFixed(4)})`) +
                    ` trying ${JSON.stringify(info.current)}:`,
                info.currentSize, info.bestUpdated ? '<-' : info.currentRejected ? 'x' : '');
        });
        if (verbose >= 0) {
            console.warn(
                `search done in ${(result.elapsedMsecs / 1000).toFixed(1)}s, ` +
                `use \`${preferText ? '-t text ' : ''}-S ${result.best.join(',')}\` to replicate:`,
                result.bestSize);
        }
    }

    const packed = packer.makeDecoder();
    const output = packed.firstLine + '\n' + packed.secondLine;
    const origLength = inputs.reduce((acc, { data } ) => {
        return acc + (Array.isArray(data) ? data.length : unescape(encodeURIComponent(data)).length);
    }, 0);
    const compressedLength = packed.estimateLength();
    const ratio = origLength > 0 ? 100 - compressedLength / origLength * 100 : -Infinity;
    if (!optimize && verbose >= 0) {
        console.warn(`compressed ${origLength}B into ${compressedLength}B (estimated, ${Math.abs(ratio).toFixed(2)}% ${ratio > 0 ? 'smaller' : 'larger'}).`);
    }
    if (outputPath === '-') {
        console.log(output); // this includes a trailing newline, use the file output to get rid of it
    } else {
        fs.writeFileSync(outputPath, output, { encoding: 'utf-8' });
    }
}

let parsed;
try {
    parsed = await parseArgs(process.argv.slice(2));
} catch (e) {
    if (typeof e === 'string') {
        console.warn(`Error: ${e}`);
        process.exit(1);
    }
    throw e;
}

switch (parsed.command) {
    case 'compress':
        try {
            await compress(parsed);
        } catch (e) {
            // correctly format known classes of errors
            if (e instanceof Error) {
                const m = e.message.match(/^Packer: (.*)$/);
                if (m) {
                    console.warn(`Error: ${m[1]}`);
                    process.exit(1);
                }
            }
            throw e;
        }
        break;

    case 'usage':
        usage();
        process.exit(0);

    case 'version':
        console.log(`Roadroller ${VERSION}`);
        process.exit(0);

    default:
        usage();
        process.exit(1);
}

