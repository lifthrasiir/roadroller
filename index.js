// Roadroller.js: Flattens your JS demo
// Copyright (c) 2021 Kang Seonghoon. See LICENSE.txt for details.

import {
    jsTokens,
    TYPE_WhiteSpace,
    TYPE_MultiLineComment,
    TYPE_SingleLineComment,
    TYPE_LineTerminatorSequence,
    TYPE_IdentifierName,
    TYPE_StringLiteral,
    TYPE_NoSubstitutionTemplate,
    TYPE_TemplateHead,
    TYPE_TemplateTail,
    TYPE_RegularExpressionLiteral,
    TYPE_Invalid,
} from './js-tokens.js';

import { estimateDeflatedSize } from './deflate.js';

//------------------------------------------------------------------------------

export class ArrayBufferPool {
    constructor() {
        // pool.get(size) is an array of ArrayBuffer of given size
        this.pool = new Map();
    }

    allocate(parent, size) {
        const available = this.pool.get(size);
        let buf;
        if (available) buf = available.pop();
        if (!buf) buf = new ArrayBuffer(size);
        return buf;
    }

    // FinalizationRegistry is also possible, but GC couldn't keep up with the memory usage
    release(buf) {
        let available = this.pool.get(buf.byteLength);
        if (!available) {
            available = [];
            this.pool.set(buf.byteLength, available);
        }
        available.push(buf);
    }
}

const newUintArray = (pool, parent, nbits, length) => {
    if (nbits <= 8) return new Uint8Array(pool ? pool.allocate(parent, length) : length);
    if (nbits <= 16) return new Uint16Array(pool ? pool.allocate(parent, length * 2) : length);
    if (nbits <= 32) return new Uint32Array(pool ? pool.allocate(parent, length * 4) : length);
    throw 'newUintArray: nbits is too large';
};

//------------------------------------------------------------------------------

const getAnsL = outBits => 1 << (28 - outBits);

// roughly based on https://github.com/rygorous/ryg_rans/blob/master/rans_byte.h
export class AnsEncoder {
    constructor({ outBits, precision }) {
        // all input frequencies are assumed to be scaled by 2^precision
        this.precision = precision;

        // the number of output bits
        this.outBits = outBits;

        // the bits and corresponding frequencies to be written.
        // rANS decoder and encoder works in the reverse.
        // therefore we buffer bits and encode them in the reverse,
        // so that the decoder will decode bits in the correct order.
        this.input = [];
    }

    writeBit(bit, predictedFreq) {
        if (bit !== 0 && bit !== 1) {
            throw new Error('AnsEncoder.writeBit: bad bit');
        }
        if (predictedFreq !== ~~predictedFreq ||
            predictedFreq < 0 ||
            predictedFreq >= (1 << this.precision)
        ) {
            throw new Error('AnsEncoder.writeBit: bad predictedFreq');
        }
        if (this.finished) {
            throw new Error('AnsEncoder.writeBit: already finished');
        }
        this.input.push({ bit, predictedFreq });
    }

    finish() {
        if (this.finished) {
            throw new Error('AnsEncoder.writeBit: already finished');
        }
        this.finished = true;

        // the lower bound of the normalized interval
        const L = getAnsL(this.outBits);
        const MASK = (1 << this.outBits) - 1;

        let state = L;

        const buf = [];
        const probScale = this.precision + 1;
        for (const { bit, predictedFreq } of this.input.reverse()) {
            // example: if precision=2, freq={0, 1, 2, 3} map to prob={1/8, 3/8, 5/8, 7/8}.
            // this adjustment is used to avoid the probability of exactly 0 or 1.
            const prob = (predictedFreq << 1) | 1;

            let start, size;
            if (bit) {
                start = 0;
                size = prob;
            } else {
                start = prob;
                size = (1 << probScale) - prob;
            }

            // renormalize
            const maxState = (L >> probScale << this.outBits) * size;
            while (state >= maxState) {
                buf.push(state & MASK);
                state >>= this.outBits;
            }

            // add the bit to the state
            state = ((state / size | 0) << probScale) + state % size + start;
            if (state >= 0x80000000) {
                throw new Error('ANSEncoder.finish: state overflow');
            }
        }

        buf.reverse();
        return { state, buf };
    }
}

export class AnsDecoder {
    constructor({ state, buf }, { outBits, precision }) {
        this.state = state;
        this.buf = buf;
        this.offset = 0;
        this.precision = precision;
        this.outBits = outBits;
        this.L = getAnsL(this.outBits);
    }

    readBit(predictedFreq) {
        const prob = (predictedFreq << 1) | 1;
        const probScale = this.precision + 1;

        const rem = this.state & ((1 << probScale) - 1);
        const bit = rem < prob ? 1 : 0;

        let start, size;
        if (bit) {
            start = 0;
            size = prob;
        } else {
            start = prob;
            size = (1 << probScale) - prob;
        }

        this.state = size * (this.state >> probScale) + rem - start;

        // renormalize
        while (this.state < this.L) {
            if (this.offset >= this.buf.length) {
                throw new Error('AnsDecoder.readBit: out of buffer bounds');
            }
            this.state <<= this.outBits;
            this.state |= this.buf[this.offset++] & ((1 << this.outBits) - 1);
        }

        return bit;
    }
}

//------------------------------------------------------------------------------

export class DirectContextModel {
    constructor({ inBits, contextBits, precision, modelMaxCount, arrayBufferPool }) {
        this.inBits = inBits;
        this.contextBits = contextBits;
        this.precision = precision;
        this.modelMaxCount = modelMaxCount;

        this.arrayBufferPool = arrayBufferPool;
        this.predictions = newUintArray(arrayBufferPool, this, precision, 1 << contextBits);
        this.counts = newUintArray(arrayBufferPool, this, Math.ceil(Math.log2(modelMaxCount)), 1 << contextBits);
        this.predictions.fill(1 << (precision - 1));
        this.counts.fill(0);

        this.bitContext = 1;
    }

    predict(context = 0) {
        context = (context + this.bitContext) & ((1 << this.contextBits) - 1);
        return this.predictions[context];
    }

    update(actualBit, context = 0) {
        if (actualBit !== 0 && actualBit !== 1) {
            throw new Error('DirectContextModel.update: bad actualBit');
        }

        context = (context + this.bitContext) & ((1 << this.contextBits) - 1);

        if (this.counts[context] < this.modelMaxCount) {
            ++this.counts[context];
        }

        // adjust P = predictions[context] by (actual - P) / (counts[context] + 0.5).
        // when delta = (actual - P) * 2, this adjustment equals to delta / (2 * counts[context] + 1).
        // in the compact decoder (2 * counts[context] + 1) is directly stored in the typed array.
        //
        // claim:
        // 1. the entire calculation always stays in the 32-bit signed integer.
        // 2. P always stays in the [0, 2^precision) range.
        //
        // proof:
        // assume that 0 <= P < 2^precision and P is an integer.
        // counts[context] is already updated so counts[context] >= 1.
        //
        // if delta > 0, delta = (2^precision - P) * 2^(30-precision) < 2^30.
        // then P' = P + trunc(delta / (2 * counts[context] + 1)) / 2^(29-precision)
        //        <= P + delta / 3 / 2^(29-precision)
        //         = P + (2^precision - P) * 2^(30-precision) / 2^(29-precision) / 3
        //         = 2/3 2^precision + 1/3 P
        //        <= 2/3 2^precision + 1/3 (2^precision - 1)
        //         = 2^precision - 1/3.
        // therefore P' < 2^precision.
        //
        // if delta < 0, delta = -P * 2^(30-precision) > -2^30.
        // then P' = P + trunc(delta / (2 * counts[context] + 1)) / 2^(29-precision)
        //        >= P + delta / 3 / 2^(29-precision)
        //         = P - 2/3 P
        //         > 0.
        // therefore P' >= 0.
        const delta = ((actualBit << this.precision) - this.predictions[context]) << (30 - this.precision);
        this.predictions[context] += (delta / (2 * this.counts[context] + 1) | 0) >> (29 - this.precision);

        this.bitContext = (this.bitContext << 1) | actualBit;
    }

    flushByte() {
        this.bitContext = 1;
    }

    release() {
        if (this.arrayBufferPool) {
            if (this.predictions) this.arrayBufferPool.release(this.predictions.buffer);
            if (this.counts) this.arrayBufferPool.release(this.counts.buffer);
            this.predictions = null;
            this.counts = null;
        }
    }
}

export class SparseContextModel extends DirectContextModel {
    constructor(options) {
        super(options);

        this.selector = options.sparseSelector;
        this.recentBytes = [];
        for (let i = 0; (this.selector >> i) > 0; ++i) {
            this.recentBytes.push(0);
        }
        this.sparseContext = 0;
    }

    predict(context = 0) {
        return super.predict(this.sparseContext + context);
    }

    update(actualBit, context = 0) {
        super.update(actualBit, this.sparseContext + context);
    }

    flushByte(currentByte, inBits) {
        super.flushByte(currentByte, inBits);

        this.recentBytes.unshift(currentByte);
        this.recentBytes.pop();

        let context = 0;
        for (let i = this.recentBytes.length - 1; i >= 0; --i) {
            if (this.selector >> i & 1) {
                // this can result in negative numbers, which should be "fixed" by later bit masking
                context = (context + this.recentBytes[i]) * 997 | 0;
            }
        }
        this.sparseContext = context;
    }
}

export class LogisticMixModel {
    constructor(models, { recipLearningRate, precision }) {
        this.models = models;
        this.precision = precision;
        this.recipLearningRate = recipLearningRate;

        this.mixedProb = 0;
        this.stretchedProbs = [];
        this.weights = [];
        for (let i = 0; i < models.length; ++i) {
            this.stretchedProbs.push(0);
            this.weights.push(0);
        }
    }

    predict(context = 0) {
        let total = 0;
        for (let i = 0; i < this.models.length; ++i) {
            const weight = this.weights[i];
            const prob = this.models[i].predict(context) * 2 + 1;
            const stretchedProb = Math.log(prob / ((2 << this.precision) - prob));
            this.stretchedProbs[i] = stretchedProb;
            total += weight * stretchedProb;
        }

        // since CM is the last model and predictions are not stored,
        // we can just compute the external probability directly.
        const mixedProb = ((2 << this.precision) - 1) / (1 + Math.exp(-total));
        this.mixedProb = mixedProb | 1;

        // this adjustment can be combined and elided in the optimized decompressor
        return this.mixedProb >> 1;
    }

    update(actualBit, context = 0) {
        const mixedProb = this.mixedProb / (2 << this.precision);
        for (let i = 0; i < this.models.length; ++i) {
            this.models[i].update(actualBit, context);

            let prob = this.stretchedProbs[i];
            prob = prob / this.recipLearningRate;
            this.weights[i] += prob * (actualBit - mixedProb);
        }
    }

    flushByte(currentByte, inBits) {
        for (const model of this.models) {
            model.flushByte(currentByte, inBits);
        }
    }

    release() {
        for (const model of this.models) {
            if (model.release) model.release();
        }
    }
}

//------------------------------------------------------------------------------

export class DefaultModel extends LogisticMixModel {
    constructor(options) {
        const { inBits, sparseSelectors, modelQuotes } = options;
        const models = sparseSelectors.map(sparseSelector => {
            return new SparseContextModel({ sparseSelector, ...options });
        });
        super(models, options);

        this.modelQuotes = modelQuotes;
        this.quote = 0;
        this.quotesSeen = new Set();
    }

    predict(context = 0) {
        if (this.quote > 0) context += 129;
        return super.predict(context);
    }

    update(actualBit, context = 0) {
        if (this.quote > 0) context += 129;
        super.update(actualBit, context);
    }

    flushByte(currentByte, inBits) {
        super.flushByte(currentByte, inBits);

        if (this.modelQuotes) {
            if (this.quote && this.quote === currentByte) {
                this.quote = 0;
            } else if (!this.quote && [34, 39, 96].includes(currentByte)) {
                this.quote = currentByte;
                this.quotesSeen.add(currentByte);
            }
        }
    }
}

//------------------------------------------------------------------------------

export const compressWithModel = (input, model, options) => {
    const { inBits, outBits, precision, calculateByteEntropy } = options;
    const encoder = new AnsEncoder(options);

    const byteProbs = [];
    for (let offset = 0; offset < input.length; ++offset) {
        const code = input[offset];
        let byteProb = calculateByteEntropy ? 1 : 0;
        for (let i = inBits - 1; i >= 0; --i) {
            const bit = (code >> i) & 1;
            const prob = model.predict();
            if (byteProb) {
                byteProb *= (bit ? prob : (1 << precision) - prob) * 2 + 1;
            }
            encoder.writeBit(bit, prob);
            model.update(bit);
        }
        model.flushByte(code, inBits);
        if (calculateByteEntropy) {
            byteProbs.push(byteProb);
        }
    }

    if (model.release) model.release();
    const { state, buf } = encoder.finish();

    let byteEntropy;
    if (calculateByteEntropy) {
        byteEntropy = byteProbs.map(prob => (precision + 1) * inBits - Math.log2(prob));
    }

    const bufLengthInBytes = Math.ceil(buf.length * outBits / 8);
    return { state, buf, inputLength: input.length, bufLengthInBytes, byteEntropy };
};

export const decompressWithModel = ({ state, buf, inputLength }, model, options) => {
    const { inBits } = options;
    const decoder = new AnsDecoder({ state, buf }, options);

    const reconstructed = [];
    for (let offset = 0; offset < inputLength; ++offset) {
        let current = 0;
        for (let i = inBits - 1; i >= 0; --i) {
            const prob = model.predict();
            const actualBit = decoder.readBit(prob);
            current = (current << 1) | actualBit;
            model.update(actualBit);
        }
        model.flushByte(current, inBits);
        reconstructed.push(current);
    }

    if (model.release) model.release();
    return reconstructed;
};

//------------------------------------------------------------------------------

// we do not automatically search beyond 9th order for the simpler decoder code
const AUTO_SELECTOR_LIMIT = 512;

export const defaultSparseSelectors = (numContexts = 12) => {
    numContexts = Math.max(0, Math.min(64, numContexts));

    // this was determined from running optimizeSparseSelectors([]) against samples,
    // where selectors are limited to 0..63 for more thorough search.
    // these were most frequent sparse orders and should be a good baseline.
    const selectors = [0, 1, 2, 3, 6, 7, 13, 21, 25, 42, 50, 57].slice(0, numContexts);

    // if more contexts are desired we just add random selectors.
    while (selectors.length < numContexts) {
        const added = Math.random() * AUTO_SELECTOR_LIMIT | 0;
        if (!selectors.includes(added)) selectors.push(added);
    }

    return selectors.sort((a, b) => a - b);
};

export const optimizeSparseSelectors = async (selectors, calculateSize, progress) => {
    let current = selectors.slice();
    let currentSize = calculateSize(selectors);
    let best = selectors.slice();
    let bestSize = currentSize;

    if (progress) {
        const info = { temperature: Infinity, current, currentSize, currentRejected: false, best, bestSize, bestUpdated: true };
        if (await progress(info) === false) throw new Error('search aborted');
    }

    // simulated annealing
    const searchStart = performance.now();
    let temperature = 1;
    while (temperature > 0.1) {
        const last = current.slice();

        let added;
        do {
            added = Math.random() * AUTO_SELECTOR_LIMIT | 0;
        } while (current.includes(added));
        current[Math.random() * current.length | 0] = added;
        current.sort((a, b) => a - b);

        const size = calculateSize(current);
        let bestUpdated = false;
        if (size < bestSize) {
            best = current.slice();
            bestSize = size;
            bestUpdated = true;
        }

        // if size > currentSize then accept by some probability exp(delta / kT) < 1
        const rejected = Math.exp((currentSize - size) / (6 * temperature)) < Math.random();
        if (progress) {
            const info = { temperature, current, currentSize: size, currentRejected: rejected, best, bestSize, bestUpdated };
            if (await progress(info) === false) throw new Error('search aborted');
        }
        if (rejected) {
            current = last;
        } else {
            currentSize = size;
        }

        temperature *= 0.99;
    }

    return { elapsedMsecs: performance.now() - searchStart, best, bestSize }
};

//------------------------------------------------------------------------------

const predictionBytesPerContext = options => (options.precision <= 8 ? 1 : options.precision <= 16 ? 2 : 4);
const countBytesPerContext = options => (options.modelMaxCount < 128 ? 1 : options.modelMaxCount < 32768 ? 2 : 4);

// String.fromCharCode(...array) is short but doesn't work when array.length is "long enough".
// the threshold is implementation-defined, but 2^16 - epsilon seems common.
const TEXT_DECODER_THRESHOLD = 65000;

export class Packer {
    constructor(inputs, options = {}) {
        this.options = {
            sparseSelectors: options.sparseSelectors ? options.sparseSelectors.slice() : defaultSparseSelectors(),
            maxMemoryMB: options.maxMemoryMB || 150,
            precision: options.precision || 16,
            modelMaxCount: options.modelMaxCount || 63,
            recipLearningRate:
                options.recipLearningRate ||
                Math.max(1, Math.round((options.learningRateDenom || 256) / (options.learningRateNum || 1))),
            contextBits: options.contextBits,
            arrayBufferPool: options.arrayBufferPool,
            numAbbreviations: typeof options.numAbbreviations === 'number' ? options.numAbbreviations : 64,
        };
        if (!this.options.contextBits) {
            const bytesPerContext = predictionBytesPerContext(this.options) + countBytesPerContext(this.options);
            this.options.contextBits = Math.log2(this.options.maxMemoryMB / this.options.sparseSelectors.length / bytesPerContext) + 20 | 0;
        }

        this.inputsByType = {};
        this.evalInput = null;
        for (let i = 0; i < inputs.length; ++i) {
            const { data, type, action } = inputs[i];
            const input = { data, type, action };
            if (!['js', 'glsl', 'html', 'text', 'binary'].includes(type)) {
                throw new Error('Packer: unknown input type');
            }
            if (!['eval', 'json', 'string', 'write', 'console', 'return', 'array', 'u8array', 'base64'].includes(action)) {
                throw new Error('Packer: unknown input action');
            }
            if (typeof data === 'string' && type === 'binary') {
                throw new Error('Packer: binary input should have an array-like data');
            }
            if (typeof data !== 'string' && type !== 'binary') {
                throw new Error('Packer: non-binary input should have a string data');
            }
            if (!['js', 'text'].includes(type) && ['eval', 'json'].includes(action)) {
                throw new Error('Packer: eval or json actions can be used only with js inputs');
            }
            if (type === 'binary' && ['string', 'write', 'console'].includes(action)) {
                throw new Error('Packer: binary inputs cannot use string or write action');
            }
            this.inputsByType[type] = this.inputsByType[type] || [];
            this.inputsByType[type].push(input);
            if (action === 'eval') {
                if (this.evalInput) {
                    throw new Error('Packer: there can be at most one input with eval action');
                }
                this.evalInput = input;
            }
        }

        // TODO
        if (inputs.length !== 1 || !['js', 'text'].includes(inputs[0].type) || !['eval', 'write', 'console', 'return'].includes(inputs[0].action)) {
            throw new Error('Packer: this version of Roadroller supports exactly one JS or text input, please stay tuned for more!');
        }
    }

    get memoryUsageMB() {
        const bytesPerContext = predictionBytesPerContext(this.options) + countBytesPerContext(this.options);
        return this.options.sparseSelectors.length * bytesPerContext * (1 << this.options.contextBits) / 1048576;
    }

    static prepareText(inputs) {
        let text = inputs.map(input => input.data).join('');
        if (text.length >= TEXT_DECODER_THRESHOLD || text.match(/[\u0100-\uffff]/)) {
            return { utf8: true, text: unescape(encodeURIComponent(text)) };
        } else {
            return { utf8: false, text };
        }
    }

    static prepareJs(inputs, { numAbbreviations }) {
        // we strongly avoid a token like 'this\'one' because the context model doesn't
        // know about escapes and anything after that would be suboptimally compressed.
        // we can't still avoid something like `foo${`bar`}quux`, where `bar` would be
        // suboptimall compressed, but at least we will return to the normal state at the end.
        const reescape = (s, pattern) =>
            s.replace(
                new RegExp(`\\\\?(${pattern})|\\\\.`, 'g'),
                (m, q) => q ? '\\x' + q.charCodeAt(0).toString(16).padStart(2, '0') : m);

        const identFreqs = new Map();
        for (const input of inputs) {
            const tokens = [];

            for (const token of jsTokens(input.data)) {
                if (token.closed === false) {
                    throw new Error('Packer: invalid JS code in the input');
                }

                switch (token.type) {
                    case TYPE_WhiteSpace:
                    case TYPE_MultiLineComment:
                    case TYPE_SingleLineComment:
                        continue;

                    case TYPE_LineTerminatorSequence:
                        if ((tokens[tokens.length - 1] || {}).type === TYPE_LineTerminatorSequence) continue;
                        token.value = '\n'; // normalize to the same terminator
                        break;

                    case TYPE_IdentifierName:
                        if (token.value.length > 1) {
                            identFreqs.set(token.value, (identFreqs.get(token.value) || 0) + 1);
                        }
                        break;

                    case TYPE_StringLiteral:
                    case TYPE_NoSubstitutionTemplate:
                        token.value = token.value[0] + reescape(token.value.slice(1, -1), token.value[0]) + token.value[0];
                        try {
                            forbiddenIdents.add((0, eval)(token.value));
                        } catch {
                            // the identifier likely has an invalid escape sequence, can ignore them
                        }
                        break;

                    case TYPE_TemplateHead:
                        token.value = '`' + reescape(token.value.slice(1), '`');
                        break;

                    case TYPE_TemplateTail:
                        token.value = reescape(token.value.slice(0, -1), '`') + '`';
                        break;

                    case TYPE_RegularExpressionLiteral:
                        token.value = reescape(token.value, '[\'"`]');
                        break;

                    case TYPE_Invalid:
                        throw new Error('Packer: invalid JS code in the input');
                }

                token.value = token.value
                    // \n, \r, \r\n all reads as \n in JS, so there is no reason not to normalize them
                    .replace(/\r\n?/g, '\n')
                    // identifiers in addition to string literals can be escaped in JS code.
                    // those characters can't appear anywhere else, so this doesn't alter the validity.
                    .replace(/[^\n\x20-\x7f]/g, m => '\\u' + m.charCodeAt(0).toString(16).padStart(4, '0'));

                tokens.push(token);
            }

            if ((tokens[tokens.length - 1] || {}).type === TYPE_LineTerminatorSequence) tokens.pop();
            input.tokens = tokens;
        }

        const unseenChars = new Set();
        for (let i = 0; i < 128; ++i) {
            // even though there might be no whitespace in the tokens,
            // we may have to need some space between two namelike tokens later.
            if (![32, 34, 39, 96].includes(i)) unseenChars.add(String.fromCharCode(i));
        }
        for (const input of inputs) {
            for (const token of input.tokens) {
                for (const ch of token.value) unseenChars.delete(ch);
            }
        }
        const usableChars = [...unseenChars].sort();

        // replace "common" enough identifiers & reserved words with unused characters.
        //
        // "commonness" is determined by a heuristic score and not by an output length,
        // since the compressor does perform a sort of deduplication via its context modelling
        // and it's hard to calculate the actual compressed size beforehand.
        // therefore this should be rather thought as reducing the burden of context models.
        // (this is also why the full deduplication actually performs worse than no deduplication.)
        let commonIdents = [...identFreqs.entries()]
            .map(([ident, freq]) => [ident, ident.length * (freq - 1)])
            .filter(([, score]) => score > 0)
            .sort(([, a], [, b]) => b - a)
            .slice(0, usableChars.length)
            .map(([ident], i) => [ident, usableChars[i]]);
        const maxAbbreviations = commonIdents.length;
        commonIdents = commonIdents.slice(0, numAbbreviations);
        const identAbbrs = new Map(commonIdents);

        // construct the combined code with abbreviations replaced, inserting a whitespace as needed
        let output = '';
        let prevToken;
        const NEED_SPACE_BEFORE = 1, NEED_SPACE_AFTER = 2;
        const needSpace = {};
        let consecutiveAbbrs = new Set(); // a set of two abbreviated chars appearing in a row
        for (const input of inputs) {
            for (const token of input.tokens) {
                /*
                if (token.value.match(/\$ROADROLLER.*\$/)) {
                    // $ROADROLLERnn$ gets replaced with the input nn
                }
                */

                if (token.type === TYPE_IdentifierName) {
                    token.abbr = identAbbrs.get(token.value);
                }

                // insert a space if needed
                if (prevToken && (
                    // - `ident1 ident2` vs. `ident1ident2`
                    // - `ident1 234` vs. `ident1234` (but e.g. `case.123` is okay)
                    (prevToken.type === TYPE_IdentifierName && token.value.match(/^[\w$\\]/)) ||
                    // - `a / /.../` vs. `a //.../`
                    // - `/.../ in b` vs. `/.../in b`; also applies to other names or number literals
                    //   starting with digits, but only `in` and `instanceof` are possible in the valid JS.
                    // - `a + + b` vs. `a ++ b`
                    // - `a - - b` vs. `a -- b`
                    // - short HTML comments only recognized in web browsers:
                    //   - `a < ! --b` vs. `a <!--b`
                    //   - `a-- > b` vs. `a-->b`
                    (prevToken.value + ' ' + token.value).match(/^\/ \/|\/ in(?:stanceof)?$|^(?:\+ \+|- -|! --|-- >)$/)
                )) {
                    if (prevToken.abbr) {
                        if (token.abbr) {
                            // either one of prevToken or token should have a space in the abbreviation;
                            // we resolve which one to put a space later
                            consecutiveAbbrs.add(prevToken.abbr + token.abbr);
                        } else {
                            needSpace[prevToken.abbr] |= NEED_SPACE_AFTER;
                        }
                    } else if (token.abbr) {
                        needSpace[token.abbr] |= NEED_SPACE_BEFORE;
                    } else {
                        output += ' ';
                    }
                }

                output += token.abbr || token.value;
                prevToken = token;
            }
        }

        // resolve consecutive abbrs, by putting the minimal number of additional spaces to them.
        // this is actually a hard problem, corresponding to finding 2-coloring of given bipartite graph
        // with the biggest difference in partition sizes, which is a set cover problem in disguise.
        // we use a greedy approximation algorithm that chooses the abbr with the most covering every time.
        while (true) {
            consecutiveAbbrs = new Set([...consecutiveAbbrs].filter(abbrs => {
                return !(needSpace[abbrs[0]] & NEED_SPACE_AFTER) && !(needSpace[abbrs[1]] & NEED_SPACE_BEFORE);
            }));
            if (consecutiveAbbrs.size === 0) break;

            const covers = new Map();
            for (const abbrs of consecutiveAbbrs) {
                const left = (abbrs.charCodeAt(0) << 1);
                const right = (abbrs.charCodeAt(1) << 1) | 1;
                covers.set(left, (covers.get(left) || 0) + 1);
                covers.set(right, (covers.get(right) || 0) + 1);
            }
            const [[best]] = [...covers.entries()].sort(([a,na], [b,nb]) => (nb - na) || (a - b));
            needSpace[String.fromCharCode(best >> 1)] |= best & 1 ? NEED_SPACE_BEFORE : NEED_SPACE_AFTER;
        }

        let replacements = '';
        for (const [ident, abbr] of commonIdents) {
            if (needSpace[abbr] & NEED_SPACE_BEFORE) replacements += ' ';
            replacements += ident;
            if (needSpace[abbr] & NEED_SPACE_AFTER) replacements += ' ';
            replacements += abbr;
        }
        return { abbrs: commonIdents, code: replacements + output, maxAbbreviations };
    }

    makeDecoder() {
        const preparedText = Packer.prepareText(this.inputsByType.text || [], this.options);
        const preparedJs = Packer.prepareJs(this.inputsByType.js || [], this.options);
        if (this.options.numAbbreviations > preparedJs.maxAbbreviations) {
            // we have no more than this many abbreviations, so later optimization should be limited to this
            this.options.numAbbreviations = preparedJs.maxAbbreviations;
        }
        // TODO if we are to have multiple inputs they have to be splitted
        const combinedInput = [...preparedText.text, ...preparedJs.code].map(c => c.charCodeAt(0));

        const inBits = combinedInput.every(c => c <= 0x7f) ? 7 : 8;
        const outBits = 6;
        // TODO again, this should be controlled dynamically
        const modelQuotes = preparedJs.code.length > 0;

        const { sparseSelectors, contextBits, precision, modelMaxCount, recipLearningRate } = this.options;

        const compressOptions = { inBits, outBits, modelQuotes, ...this.options };
        const model = new DefaultModel(compressOptions);
        const { buf, state, inputLength, bufLengthInBytes } = compressWithModel(combinedInput, model, compressOptions);

        const numModels = sparseSelectors.length;
        const predictionBits = 8 * predictionBytesPerContext(compressOptions);
        const countBits = 8 * countBytesPerContext(compressOptions);

        const selectors = [];
        for (const selector of sparseSelectors) {
            const bits = [];
            for (let j = 0; (1 << j) <= selector; ++j) {
                if (selector >> j & 1) bits.push(j + 1);
            }
            selectors.push(bits.reverse());
        }
        const singleDigitSelectors = sparseSelectors.every(sel => sel < 512);
        const quotes = [...model.quotesSeen].sort((a, b) => a - b);

        const stringifiedInput = utf8 =>
            // if the input length crosses the threshold,
            // the input is either forced to be encoded in UTF-8
            // or (in the case of JS inputs) always in ASCII thus can be decoded as UTF-8.
            utf8 || inputLength >= TEXT_DECODER_THRESHOLD ?
                `new TextDecoder().decode(new Uint8Array(o))` :
                `String.fromCharCode(...o)`;

        // \0 is technically allowed by JS but can't appear in <script>
        const escapeCharInTemplate = c => ({ '\0': '\\0', '\r': '\\r', '\\': '\\\\', '`': '\\`' })[c] || c;
        const escapeCharInCharClass = c => ({ '\0': '\\0', '\r': '\\r', '\n': '\\n', '\\': '\\\\', ']': '\\]' })[c] || c;

        const makeCharClass = (set, toggle) => {
            const ranges = [];
            let runStart = -1;
            for (let i = 0; i <= (1 << inBits); ++i) {
                if (i < (1 << inBits) && set.has(i) === toggle) {
                    if (runStart < 0) runStart = i;
                } else if (runStart >= 0) {
                    const runEnd = i - 1;
                    let range = escapeCharInCharClass(String.fromCharCode(runStart));
                    if (runStart + 1 < runEnd) range += '-';
                    if (runStart < runEnd) range += escapeCharInCharClass(String.fromCharCode(runEnd));
                    ranges.push(range);
                    runStart = -1;
                }
            }

            // make sure that the first range doesn't start with ^
            if (ranges.length > 0 && ranges[0][0] === '^') {
                if (ranges.length > 1) {
                    ranges.push(ranges.unshift());
                } else {
                    ranges[0] = '\\' + ranges[0];
                }
            }
            return (toggle ? '' : '^') + ranges.join('');
        };

        const pow2 = n => {
            if (n < 10) return '' + (1 << n);
            // make use of M = 2^(precision+1) as much as possible
            n -= precision + 1;
            if (n < 0) return `M/${1 << -n}`;
            if (n > 0) return `M*${1 << n}`;
            return 'M';
        };

        // the decoder consists of three loops and its code order doesn't match
        // with the execution order, which is denoted with the preceding number.

        // 0.
        // A: rANS output encoded in lowest 6 bits (higher bits are chosen to avoid backslash)
        // this should be isolated from other code for the best DEFLATE result
        let firstLine = `A='`;
        const CHUNK_SIZE = 8192;
        for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
            firstLine += String.fromCharCode(...buf.slice(i, i + CHUNK_SIZE).map(c => c === 0x1c || c === 0x3f ? c : c | 0x40));
        }
        firstLine += `'`;

        let secondLine =
            // 1. initialize other variables
            //
            // t: rANS state
            // w: weights
            // p: predictions
            // c: counts * 2 + 1
            `t=${state};` +
            `M=1<<${precision + 1};` +
            `w=${JSON.stringify(Array(numModels).fill(0))};` +
            `p=new Uint${predictionBits}Array(${numModels}<<${contextBits}).fill(${pow2(precision - 1)});` +
            `c=new Uint${countBits}Array(${numModels}<<${contextBits}).fill(1);` +

            // o: decoded data
            // r: read position in A
            // l: write position in o
            // f: if in string the quote character code, otherwise 0 (same to state.quote)
            // we know the exact input length, so we don't have the end of data symbol
            `for(o=[r=l=${quotes.length > 0 ? 'f=' : ''}0];` +

                // 2. read until the known length
                `l<${inputLength};` +

                // 7. code to be executed after reading one byte
                //
                // a is now the decode byte plus additional topmost 1 bit, write (and keep) it
                `o[l++]=a-=${1 << inBits}` +

            (quotes.length > 0 ?
                // update f according to a
                `,f=f?` +
                    // if we are in a string we either keep f or reset to 0 if f appeared again
                    `a-f&&f:` +
                    // otherwise we set f to a if a is one of opening quotes
                    // (we only process quotes that actually have appeared in the input)
                    (quotes.length > 1 ?
                        `(${quotes.map(q => `a==${q}`).join('|')})&&a` :
                        `a==${quotes[0]}&&a`)
            : '') +

            `)` +

            // 3. bitwise read loop
            //
            // a: bit context, equal to `0b1xx..xx` where xx..xx is currently read bits
            // if a got more than inBits bits we are done reading one input character
            `for(a=1;a<${1 << inBits};` +

                // 6. update contexts and weights with e and a (which is now the bit context)
                //
                // i: model index (unique in the entire code)
                `u.map((C,i)=>(` +
                    // update the bitwise context (we haven't updated a yet, so this is fine)
                    // y is not used but used here to exploit a repeated code fragment
                    `y=p[C]+=` +
                        `(e*${pow2(precision)}-p[C]<<${30 - precision})/` +
                            `(c[C]+=2*(c[C]<${2 * modelMaxCount}))` +
                        // this corresponds to delta in the DirectContextModel.update method;
                        // we've already verified delta is within +/-2^31, so `>>>` is not required
                        `>>${29 - precision},` +
                    // update the weight
                    `w[i]+=x[i]*(e-m/M)` +
                `)),` +
                `a=a*2+e` +

            `)` +

            // 4. predict and read one bit
            `for(` +

                // m: sum of weighted probabilities
                // u: the context hash
                (singleDigitSelectors ?
                    `u='${selectors.map(i => i.join('')).join('0')}'.split(m=0)`
                :
                    `m=0,u=${JSON.stringify(selectors)}`
                ) + `.map((C,i)=>` +
                    `(y=0,` +
                        (singleDigitSelectors ? `[...C]` : `C`) +
                        `.map((C,i)=>(y=y*997+(o[l-C]|0)|0)),${pow2(contextBits)}-1&y*997+a` +
                        (quotes.length > 0 ? '+!!f*129' : '') +
                    `)*${numModels}+i` +
                `),` +

                // calculate the mixed prediction m
                `x=u.map((C,i)=>(` +
                    `y=p[C]*2+1,` +
                    // stretch(prob), needed for updates
                    `y=Math.log(y/(M-y)),` +
                    `m-=w[i]*y,` +
                    // premultiply with learning rate
                    `y/${recipLearningRate}` +
                `)),` +

                // m: squash(sum of weighted preds) followed by adjustment
                `m=~-M/(1+Math.exp(m))|1,` +
                // decode the bit e
                `e=t%M<m,` +
                `t=t%M+(e?m:M-m)*(t>>${precision + 1})-!e*m` +
            `;` +

                // 5. renormalize (and advance the input offset) if needed
                `t<${pow2(28 - outBits)}` +
            `;` +
                `t=t*${1<<outBits}|A.charCodeAt(r++)&${(1 << outBits) - 1}` +
            `);`;

        // 9. postprocessing
        // also should clobber w and c to trigger the GC as soon as possible
        let outputVar = 'c'; // can be replaced with assignment statements if possible

        const [input] = this.inputsByType.text || this.inputsByType.js;
        switch (input.type) {
            case 'text':
                outputVar = stringifiedInput(preparedText.utf8);
                break;

            case 'js':
                if (preparedJs.abbrs.length === 0) {
                    outputVar = `c=w=${stringifiedInput()}`;
                } else if (preparedJs.abbrs.length < 3) {
                    secondLine += `c=w=${stringifiedInput()};`;
                    for (const [, abbr] of preparedJs.abbrs) {
                        secondLine += `with(c.split(\`${escapeCharInTemplate(abbr)}\`))c=join(shift());`;
                    }
                } else {
                    // character class is probably uncompressible so the shorter one is preferred
                    const abbrCharSet = new Set(preparedJs.abbrs.map(([, abbr]) => abbr.charCodeAt(0)));
                    const abbrCharClass1 = makeCharClass(abbrCharSet, true);
                    const abbrCharClass2 = makeCharClass(abbrCharSet, false);
                    const abbrCharClass = (abbrCharClass2.length < abbrCharClass1.length ? abbrCharClass2 : abbrCharClass1);
                    secondLine += `for(c=${stringifiedInput()};w=/[${abbrCharClass}]/.exec(c);)with(c.split(w))c=join(shift());`;
                }
                break;
        }

        switch (input.action) {
            case 'eval':
                // TODO is it significantly slower than the indirect eval `(0,eval)`?
                secondLine += `eval(${outputVar})`;
                break;
            case 'write':
                secondLine += `document.write(${outputVar})`;
                break;
            case 'console': // undocumented, mainly used for debugging
                secondLine += `console.log(${outputVar})`;
                break;
            case 'return': // undocumented, mainly used for debugging
                secondLine += outputVar;
                break;
        }

        return new Packed({ firstLine, firstLineLengthInBytes: bufLengthInBytes, secondLine });
    }

    async optimizeSparseSelectors(progress) {
        const result = await optimizeSparseSelectors(this.options.sparseSelectors, sparseSelectors => {
            this.options.sparseSelectors = sparseSelectors;
            return this.makeDecoder().estimateLength();
        }, progress);
        this.options.sparseSelectors = result.best;
        return result;
    }
}

class Packed {
    constructor({ firstLine, firstLineLengthInBytes, secondLine }) {
        this.firstLine = firstLine;
        this.firstLineLengthInBytes = firstLineLengthInBytes;
        this.secondLine = secondLine;
    }

    estimateLength() {
        return this.firstLineLengthInBytes + estimateDeflatedSize(this.secondLine);
    }
}

