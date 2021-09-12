#!/usr/bin/env node

import * as fs from 'fs';
import process from 'process';
import * as readline from 'readline';
import { performance } from 'perf_hooks';
import { ResourcePool, Packer, defaultSparseSelectors } from './index.mjs';

let VERSION = 'unknown';
try {
    VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), { encoding: 'utf-8' })).version;
} catch (e) {
}

function usage(verbose) {
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
-O|--optimize EFFORTS [Default: 0 or 1]
  Tries to tune parameters for this input.
    0   Use the baseline parameters.
        Default when any optimizable arguments are given.
    1   Tries to optimize -S and most -Z arguments with ~30 attempts.
        Default when no optimizable arguments are given.
    2   Same to -O1 but with ~300 attempts.
    O (capital letter Oh, looks like the infinity symbol ∞)
        Continuously runs -O1 through the maximal level, then
        repeatedly runs the maximal level until the user aborted.
  Anything beyond -O0 prints the best parameters unless -q is given.
  Pressing Ctrl-C (SIGINT) anytime aborts the search and proceeds
  with the best parameters so far.
-M|--max-memory MEGABYTES [Range: 10..1024, Default: 150]
  Configures the maximum memory usage.
  The actual usage might be lower. Use -v to print the actual usage.
-D|--dirty [Default: false]
  Allow the decoder to pollute the global scope.
  This is unsafe in general, but if you know that this is safe
  (i.e. no script in the global scope, no single-letter ids in use)
  then this can shave a few more bytes from the decoder.
-S|--selectors xNUMCONTEXTS [Range: 1..64, Default: 12]
  Sets the maximum number of contexts used, prefixed by a literal "x".
  For 13+ contexts additional contexts are randomly picked.
  Can be used for finer (linear) tuning of the memory usage.
` + (verbose > 0 ?
`-S|--selectors SELECTOR,SELECTOR... [Default: ${defaultSparseSelectors()}]
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
-Zdy|--dynamic-models FLAGS [Default: 1 for JS, 0 for others]
  Enables or disables specific dynamic models.
  The value is a bitwise OR of the following bits:
    1        Puts quoted strings (', ", \`) into a separate context.
             This is only useful when every quotes are paired, so it
             can't be used in English texts with contractions (e.g. isn't).
-Zlr|--learning-rate RATE [Range: 1..2^53, Default: 500]
  Configures the learning rate of context mixer; smaller adapts faster.
-Zmc|--model-max-count COUNT [Range: 1..32767, Default: 5]
  Configures the adaptation speed of context models.
  Context models adapt fastest when the context is first seen,
  but become slower each subsequent occurrence of the context.
  This option configures how slowest the adaptation can be;
  smaller COUNT is better for quickly varying (non-stationary) inputs.
-Zmd|--model-base-divisor COUNT [Range: 1..2^53-1, Default: 20]
  Configures the reciprocal of initial count when a context is first seen.
  The count is increased by 1 per occurrence and larger count decreases
  the speed of adaptation, so if this option is larger the initial count
  is made smaller and the model would behave much quicker initially.
-Zpr|--precision BITS [Range: 1..21, Default: 16]
  Sets the precision of internal fixed point representations.
` : '') + `
Other options:
-q|--silent
  Suppresses any diagnostic messages.
-v|--verbose
  Prints more information whenever appropriate. Can be repeated.
-h|--help
  Prints this message. Combine with -v for more options.
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
        resourcePool: new ResourcePool(),
    };
    let command;
    let optimize;
    let defaultOptimize = 1;
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
            command = 'usage';
        } else if (matchOpt('version', 'V')) {
            command = 'version';
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
            const arg = getArg(m);
            optimize = arg === 'O' ? Infinity : parseInt(arg, 10);
        } else if (m = matchOptArg('max-memory', 'M')) {
            if (options.maxMemoryMB !== undefined) throw 'duplicate --max-memory arguments';
            options.maxMemoryMB = parseInt(getArg(m), 10);
        } else if (m = matchOptArg('dirty', 'D')) {
            if (options.allowFreeVars !== undefined) throw 'duplicate --dirty arguments';
            options.allowFreeVars = true;
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
                defaultOptimize = 0;
            }
            options.sparseSelectors = selectors;
        } else if (m = matchOptArg('num-abbreviations', 'Zab')) {
            if (options.numAbbreviations !== undefined) throw 'duplicate --num-abbreviations arguments';
            options.numAbbreviations = parseInt(getArg(m), 10);
            defaultOptimize = 0;
        } else if (m = matchOptArg('context-bits', 'Zco')) {
            if (options.contextBits !== undefined) throw 'duplicate --context-bits arguments';
            options.contextBits = parseInt(getArg(m), 10);
            // -Zco is not optimizable, so its use doesn't change -O defaults
        } else if (m = matchOptArg('dynamic-models', 'Zdy')) {
            if (options.dynamicModels !== undefined) throw 'duplicate --dynamic-models arguments';
            options.dynamicModels = parseInt(getArg(m), 10);
        } else if (m = matchOptArg('learning-rate', 'Zlr')) {
            if (options.recipLearningRate !== undefined) throw 'duplicate --learning-rate arguments';
            options.recipLearningRate = parseInt(getArg(m), 10);
            defaultOptimize = 0;
        } else if (m = matchOptArg('model-max-count', 'Zmc')) {
            if (options.modelMaxCount !== undefined) throw 'duplicate --model-max-count arguments';
            options.modelMaxCount = parseInt(getArg(m), 10);
            defaultOptimize = 0;
        } else if (m = matchOptArg('model-base-divisor', 'Zmd')) {
            if (options.modelRecipBaseCount !== undefined) throw 'duplicate --model-base-divisor arguments';
            options.modelRecipBaseCount = parseInt(getArg(m), 10);
            defaultOptimize = 0;
        } else if (m = matchOptArg('precision', 'Zpr')) {
            if (options.precision !== undefined) throw 'duplicate --precision arguments';
            options.precision = parseInt(getArg(m), 10);
            defaultOptimize = 0;
        } else if (opt == '--') {
            nextIsArg = true;
        } else {
            throw `unknown option ${opt}`;
        }
    }

    if (Object.keys(currentInput).length > 0) {
        throw 'the last input path is missing';
    }

    const between = (a, v, b) => a <= v && v <= b; // also returns false if v is NaN

    // check validity of arguments
    if (outputPath === undefined) {
        outputPath = '-';
    }
    if (optimize === undefined) {
        optimize = defaultOptimize;
    } else if (!between(0, optimize, 2) && optimize !== Infinity) {
        throw 'invalid --optimize argument';
    }
    if (options.maxMemoryMB !== undefined) {
        if (options.contextBits !== undefined) throw '--max-memory and --context-bits cannot be used together';
        if (!between(10, options.maxMemoryMB, 1024)) throw 'invalid --max-memory argument';
    } else if (options.contextBits !== undefined) {
        if (!between(1, options.contextBits, 30)) throw 'invalid --context-bits argument';
        const numSelectors = options.sparseSelectors ? options.sparseSelectors.length : 12;
        // this implies that -Zco24 unconditionally works but -Zco25..30 may not work depending on -Sx
        if (numSelectors * (1 << options.contextBits) > (1 << 30)) throw 'invalid --context-bits argument';
    }
    if (options.sparseSelectors !== undefined) {
        if (options.sparseSelectors.length < 1) throw 'no selectors in --selectors argument';
        if (options.sparseSelectors.length > 64) throw 'too many selectors in --selectors argument';
        if (options.sparseSelectors.some(sel => sel !== sel || sel < 0 || sel >= 0x80000000)) {
            throw 'invalid selector in --selectors argument';
        }
        if (options.sparseSelectors.find((sel, i) => options.sparseSelectors[i-1] === sel)) {
            throw 'duplicate selector in --selectors argument';
        }
    }
    if (options.numAbbreviations !== undefined && !between(0, options.numAbbreviations, 64)) {
        throw 'invalid --num-abbreviations argument';
    }
    if (options.dynamicModels !== undefined && !between(0, options.dynamicModels, 1)) {
        throw 'invalid --dynamic-models argument';
    }
    if (options.recipLearningRate !== undefined && !between(1, options.recipLearningRate, 2**53)) {
        throw 'invalid --learning-rate argument';
    }
    if (options.modelMaxCount !== undefined && !between(1, options.modelMaxCount, 32767)) {
        throw 'invalid --model-max-count argument';
    }
    if (options.modelRecipBaseCount !== undefined && !between(1, options.modelRecipBaseCount, 2**53 - 1)) {
        throw 'invalid --model-base-divisor argument';
    }
    if (options.precision !== undefined && !between(1, options.precision, 28)) {
        throw 'invalid --precision argument';
    }

    if (!command && inputs.length === 0) {
        command = 'default';
    }
    if (command) {
        return { command, verbose };
    }

    return { command: 'compress', inputs, options, optimize, outputPath, verbose };
}

async function compress({ inputs, options, optimize, outputPath, verbose }) {
    let packer = new Packer(inputs, options);
    const origLength = inputs.reduce((acc, { data } ) => {
        return acc + (Array.isArray(data) ? data.length : unescape(encodeURIComponent(data)).length);
    }, 0);

    if (verbose >= 1) {
        console.warn(
            `Actual memory usage: ${packer.memoryUsageMB < 1 ? '< 1' : packer.memoryUsageMB.toFixed(1)} MB` +
            (options.contextBits ? '' : ` (out of ${options.maxMemoryMB || 150} MB)`));
    }

    if (optimize) {
        const defaultSelectorsJSON =
            !options.sparseSelectors ?
                JSON.stringify(defaultSparseSelectors()) :
            options.sparseSelectors.length <= 12 ?
                JSON.stringify(defaultSparseSelectors(options.sparseSelectors.length)) :
                ''; // more than 13 selectors are randomly determined

        const format = moreOptions => {
            const combined = { ...options, ...moreOptions };
            let args;
            if (!combined.sparseSelectors) {
                args = '-Sx12';
            } else if (JSON.stringify(combined.sparseSelectors) === defaultSelectorsJSON) {
                args = `-Sx${combined.sparseSelectors.length}`;
            } else {
                args = `-S${combined.sparseSelectors.join(',')}`;
            }
            if (typeof combined.precision === 'number') {
                args = `-Zpr${combined.precision} ${args}`;
            }
            if (typeof combined.modelRecipBaseCount === 'number') {
                args = `-Zmd${combined.modelRecipBaseCount} ${args}`;
            }
            if (typeof combined.modelMaxCount === 'number') {
                args = `-Zmc${combined.modelMaxCount} ${args}`;
            }
            if (typeof combined.recipLearningRate === 'number') {
                args = `-Zlr${combined.recipLearningRate} ${args}`;
            }
            if (typeof combined.dynamicModels === 'number') {
                args = `-Zdy${combined.dynamicModels} ${args}`;
            }
            if (typeof combined.numAbbreviations === 'number') {
                args = `-Zab${combined.numAbbreviations} ${args}`;
            }
            return args;
        };

        // FIXME this disables the default SIGINT handling in Windows,
        // so SIGINT would be doing nothing until the next log is reported
        // (when setImmediate is called and signals are actually delivered).
        // the only solution seems to be tick callbacks in compressWithModel etc.
        let stop = false;
        process.once('SIGINT', () => {
            stop = true;
        });

        let result;
        const run = async level => {
            result = await packer.optimize(level, async info => {
                await new Promise(resolve => setImmediate(resolve)); // allow signals to be delivered
                if (verbose >= 0) {
                    console.warn(
                        `(${info.pass}` +
                        (typeof info.passRatio === 'number' ? ` ${(info.passRatio * 100).toFixed(1)}%` : '') +
                        `) ${format(info.current)}:`,
                        info.currentSize, info.bestUpdated ? '<-' : info.currentRejected ? 'x' : '');
                }
                if (stop) {
                    result = info;
                    return false;
                }
            });
            options = { ...options, ...result.best };
        };

        const start = performance.now();
        try {
            if (isFinite(optimize)) {
                await run(optimize);
            } else {
                for (let i = 1; ; ++i) await run(i);
            }
        } catch (e) {
            if (!(e instanceof Error && e.message === 'search aborted')) throw e;
        }
        // do not rely on result.elapsedMsecs which may have been overwritten in -OO
        const elapsedMsecs = performance.now() - start;

        if (verbose >= 0) {
            const ratio = origLength > 0 ? 100 - result.bestSize / origLength * 100 : -Infinity;
            console.warn(
                (stop ? 'search aborted after' : 'search done in') +
                ` ${(elapsedMsecs / 1000).toFixed(1)}s, use \`${format(result.best)}\` to replicate:`,
                result.bestSize,
                `(estimated, ${Math.abs(ratio).toFixed(2)}% ${ratio > 0 ? 'smaller' : 'larger'})`);
        }
    }

    const packed = packer.makeDecoder();
    const output = packed.firstLine + packed.secondLine;
    const compressedLength = packed.estimateLength();
    const ratio = origLength > 0 ? 100 - compressedLength / origLength * 100 : -Infinity;
    if (!optimize && verbose >= 0) {
        console.warn(
            `compressed ${origLength}B into ${compressedLength}B ` +
            `(estimated, ${Math.abs(ratio).toFixed(2)}% ${ratio > 0 ? 'smaller' : 'larger'}).`);
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
        usage(parsed.verbose);
        process.exit(0);

    case 'version':
        console.log(`Roadroller ${VERSION}`);
        process.exit(0);

    default:
        usage(parsed.verbose);
        process.exit(1);
}

