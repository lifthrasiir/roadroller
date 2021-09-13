// Roadroller: Flattens your JS demo
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
} from './js-tokens.mjs';

import { estimateDeflatedSize } from './deflate.mjs';

import { getContextItemShift, makeDefaultModelRunner } from './wasm.mjs';

//------------------------------------------------------------------------------

// returns clamp(0, floor(log2(x/y)), 31) where x and y are integers.
// not prone to floating point errors.
const floorLog2 = (x, y = 1) => {
    let n = 0;
    if (x >= y * 65536) y *= 65536, n += 16;
    if (x >= y * 256) y *= 256, n += 8;
    if (x >= y * 16) y *= 16, n += 4;
    if (x >= y * 4) y *= 4, n += 2;
    if (x >= y * 2) n += 1;
    return n;
};

// returns clamp(1, ceil(log2(x/y)), 32) where x and y are integers.
// not prone to floating point errors.
const ceilLog2 = (x, y = 1) => {
    let n = 1;
    if (x > y * 65536) y *= 65536, n += 16;
    if (x > y * 256) y *= 256, n += 8;
    if (x > y * 16) y *= 16, n += 4;
    if (x > y * 4) y *= 4, n += 2;
    if (x > y * 2) n += 1;
    return n;
};

// returns [m, e, m * 10^e] where (m-1) * 10^e < v <= m * 10^e, m < 100 and m mod 10 != 0.
// therefore `${m}e${e}` is an upper bound approximation with ~2 significant digits.
const approximateWithTwoSigDigits = v => {
    if (v <= 0) return [0, 0, 0]; // special case
    let exp = 0;
    let tens = 1;
    while (v >= tens * 100) {
        ++exp;
        tens *= 10;
    }
    let mant = Math.ceil(v / tens);
    if (mant % 10 === 0) { // 60e6 -> 6e7
        mant /= 10;
        ++exp;
        tens *= 10;
    }
    return [mant, exp, mant * tens];
};

// Node.js 14 doesn't have a global performance object.
const getPerformanceObject = async () => {
    return globalThis.performance || (await import('perf_hooks')).performance;
};

//------------------------------------------------------------------------------

export class ResourcePool {
    constructor() {
        // arrayBuffers.get(size) is an array of ArrayBuffer of given size
        this.arrayBuffers = new Map();
        this.wasmRunners = new Map();
    }

    allocate(parent, size) {
        const available = this.arrayBuffers.get(size);
        let buf;
        if (available) buf = available.pop();
        if (!buf) buf = new ArrayBuffer(size);
        return buf;
    }

    // FinalizationRegistry is also possible, but GC couldn't keep up with the memory usage
    release(buf) {
        let available = this.arrayBuffers.get(buf.byteLength);
        if (!available) {
            available = [];
            this.arrayBuffers.set(buf.byteLength, available);
        }
        available.push(buf);
    }

    wasmDefaultModelRunner(contextItemShift) {
        if (!this.wasmRunners.get(contextItemShift)) {
            this.wasmRunners.set(contextItemShift, makeDefaultModelRunner(contextItemShift));
        }
        return this.wasmRunners.get(contextItemShift);
    }
}

export const ArrayBufferPool = ResourcePool;

const newUintArray = (pool, parent, nbits, length) => {
    if (nbits <= 8) return new Uint8Array(pool ? pool.allocate(parent, length) : length);
    if (nbits <= 16) return new Uint16Array(pool ? pool.allocate(parent, length * 2) : length);
    if (nbits <= 32) return new Uint32Array(pool ? pool.allocate(parent, length * 4) : length);
    throw 'newUintArray: nbits is too large';
};

//------------------------------------------------------------------------------

// this is slightly configurable (ryg_rans equivalent would be 31),
// but we already have too many parameters.
const ANS_BITS = 28;

// roughly based on https://github.com/rygorous/ryg_rans/blob/master/rans_byte.h
export class AnsEncoder {
    constructor({ outBits, precision }) {
        // all input frequencies are assumed to be scaled by 2^precision
        this.precision = precision;

        // the number of output bits, or -(the number of output symbols) if negative
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

        const outSymbols = this.outBits < 0 ? -this.outBits : 1 << this.outBits;

        let state = 1 << (ANS_BITS - ceilLog2(outSymbols));

        const buf = [];
        const probScale = this.precision + 1;
        const stateShift = ANS_BITS - ceilLog2(outSymbols) - probScale;
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
            const maxState = size * outSymbols << stateShift;
            while (state >= maxState) {
                buf.push(state % outSymbols);
                state = (state / outSymbols) | 0;
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
        this.outSymbols = outBits < 0 ? -outBits : 1 << outBits;
        this.renormLimit = 1 << (ANS_BITS - ceilLog2(this.outSymbols));
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
        while (this.state < this.renormLimit) {
            if (this.offset >= this.buf.length) {
                throw new Error('AnsDecoder.readBit: out of buffer bounds');
            }
            this.state *= this.outSymbols;
            this.state += this.buf[this.offset++] % this.outSymbols;
        }

        return bit;
    }
}

//------------------------------------------------------------------------------

export class DirectContextModel {
    constructor({ inBits, contextBits, precision, modelMaxCount, modelRecipBaseCount, arrayBufferPool, resourcePool }) {
        this.inBits = inBits;
        this.contextBits = contextBits;
        this.precision = precision;
        this.modelMaxCount = modelMaxCount;
        this.modelBaseCount = 1 / modelRecipBaseCount;

        this.resourcePool = resourcePool || arrayBufferPool;
        this.predictions = newUintArray(this.resourcePool, this, precision, 1 << contextBits);
        this.counts = newUintArray(this.resourcePool, this, ceilLog2(modelMaxCount + 1), 1 << contextBits);

        if (this.resourcePool) {
            // we need to initialize the array since it may have been already used,
            // but UintXXArray.fill is comparatively slow, less than 5 GB/s even in fastest browsers.
            // we instead use more memory to confirm that each bit of context has been initialized.
            //
            // the final excess element is the maximum mark in use.
            // (this kind of size is not used elsewhere, so we can safely reuse that.)
            // we choose a new mark to mark initialized elements *in this instance*.
            // if the mark reaches 255 we reset the entire array and start over.
            // this scheme effectively reduces the number of fill calls by a factor of 510.
            this.confirmations = newUintArray(this.resourcePool, this, 8, (1 << contextBits) + 1);
            this.mark = this.confirmations[1 << contextBits] + 1;
            if (this.mark === 256) {
                this.mark = 1;
                this.confirmations.fill(0);
            }
            this.confirmations[1 << contextBits] = this.mark;
        } else {
            this.predictions.fill(1 << (precision - 1));
            //this.counts.fill(0); // we don't really need this
        }

        this.bitContext = 1;
    }

    predict(context = 0) {
        context = (context + this.bitContext) & ((1 << this.contextBits) - 1);
        if (this.confirmations && this.confirmations[context] !== this.mark) {
            this.confirmations[context] = this.mark;
            this.predictions[context] = 1 << (this.precision - 1);
            this.counts[context] = 0;
        }
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

        // adjust P = predictions[context] by (actual - P) / (counts[context] + 1 / modelRecipBaseCount).
        // modelRecipBaseCount should be <= M such that 1 / modelRecipBaseCount isn't cancelled out.
        //
        // claim:
        // 1. the entire calculation always stays in the 32-bit signed integer.
        // 2. P always stays in the [0, 2^precision) range.
        //
        // proof:
        // assume that 0 <= P < 2^precision and P is an integer.
        // counts[context] is already updated so counts[context] >= 1.
        //
        // if delta > 0, delta = (2^precision - P) * 2^(29-precision) < 2^29.
        // then P' = P + trunc(delta / (counts[context] + 1 / modelRecipBaseCount)) / 2^(29-precision)
        //        <= P + delta / (1 + 1/M) / 2^(29-precision)
        //         = P + (2^precision - P) * 2^(29-precision) / 2^(29-precision) / (1 + 1/M)
        //         = P (1 + 1/M) / (1 + 1/M) + 2^precision / (1 + 1/M) - P / (1 + 1/M)
        //         = (2^precision - P/M) / (1 + 1/M)
        //         < 2^precision - P/M
        //        <= 2^precision.
        // therefore P' < 2^precision.
        //
        // if delta < 0, delta = -P * 2^(29-precision) > -2^29.
        // then P' = P + trunc(delta / (counts[context] + 1 / modelRecipBaseCount)) / 2^(29-precision)
        //        >= P + delta / (1 + 1/1) / 2^(29-precision)
        //         = P + (-P) / 2
        //         = P/2
        //        >= 0.
        // therefore P' >= 0.
        const delta = ((actualBit << this.precision) - this.predictions[context]) << (29 - this.precision);
        this.predictions[context] += (delta / (this.counts[context] + this.modelBaseCount) | 0) >> (29 - this.precision);

        this.bitContext = (this.bitContext << 1) | actualBit;
    }

    flushByte() {
        this.bitContext = 1;
    }

    release() {
        if (this.resourcePool) {
            if (this.predictions) this.resourcePool.release(this.predictions.buffer);
            if (this.counts) this.resourcePool.release(this.counts.buffer);
            if (this.confirmations) this.resourcePool.release(this.confirmations.buffer);
            this.predictions = null;
            this.counts = null;
            this.confirmations = null;
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
            return new SparseContextModel({ ...options, sparseSelector });
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
    const { inBits, outBits, precision, preset = [], inputEndsWithByte, calculateByteEntropy } = options;
    const encoder = new AnsEncoder(options);

    if (inputEndsWithByte !== undefined) {
        if (input.length === 0) {
            throw new Error('compressWithModel: inputEndsWithByte given but input is empty');
        }
        if (input[input.length - 1] !== inputEndsWithByte) {
            throw new Error('compressWithModel: input does not agree with inputEndsWithByte');
        }
        for (let offset = 0; offset < input.length - 1; ++offset) {
            if (input[offset] === inputEndsWithByte) {
                throw new Error('compressWithModel: input contains multiple inputEndsWithByte');
            }
        }
    }

    for (let offset = 0; offset < preset.length; ++offset) {
        const code = preset[offset];
        for (let i = inBits - 1; i >= 0; --i) {
            model.predict();
            model.update((code >> i) & 1);
        }
        model.flushByte(code, inBits);
    }

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

    const bufLengthInBytes = Math.ceil(buf.length * (outBits < 0 ? Math.log2(-outBits) : outBits) / 8);
    const inputLength = inputEndsWithByte === undefined ? input.length : -1; // so that the caller can't rely on this
    return { state, buf, inputLength, bufLengthInBytes, byteEntropy };
};

export const compressWithDefaultModel = (input, options) => {
    // if the model is _exactly_ a DefaultModel and no fancy options are in use,
    // we have a faster implementation using JIT-compiled WebAssembly instances.
    // we only use it when we have a guarantee that the wasm instance can be cached.
    let runDefaultModel;
    const resourcePool = options.resourcePool || options.arrayBufferPool;
    if (
        resourcePool &&
        (options.preset || []).length === 0 &&
        !options.disableWasm &&
        !options.calculateByteEntropy &&
        options.sparseSelectors.length <= 64 &&
        options.sparseSelectors.every(sel => sel < 0x8000)
    ) {
        const contextItemShift = getContextItemShift(options);
        const resourcePool = options.resourcePool || options.arrayBufferPool;
        try {
            runDefaultModel = resourcePool.wasmDefaultModelRunner(contextItemShift);
        } catch (e) {
            // WebAssembly is probably not supported, fall back to the pure JS impl
        }
    }

    if (runDefaultModel) {
        const { predictions, quotesSeen } = runDefaultModel(input, options);

        const { inBits, outBits } = options;
        const encoder = new AnsEncoder(options);
        for (let offset = 0, bitOffset = 0; offset < input.length; ++offset) {
            const code = input[offset];
            for (let i = inBits - 1; i >= 0; --i) {
                const bit = (code >> i) & 1;
                const prob = predictions[bitOffset++];
                encoder.writeBit(bit, prob);
            }
        }
        const { state, buf } = encoder.finish();

        const bufLengthInBytes = Math.ceil(buf.length * (outBits < 0 ? Math.log2(-outBits) : outBits) / 8);
        const inputLength = input.length;
        return { state, buf, inputLength, bufLengthInBytes, quotesSeen };
    } else {
        const model = new DefaultModel(options);
        const ret = compressWithModel(input, model, options);
        ret.quotesSeen = model.quotesSeen;
        return ret;
    }
};

export const decompressWithModel = ({ state, buf, inputLength }, model, options) => {
    const { inBits, preset = [], inputEndsWithByte } = options;
    const decoder = new AnsDecoder({ state, buf }, options);

    for (let offset = 0; offset < preset.length; ++offset) {
        const code = preset[offset];
        for (let i = inBits - 1; i >= 0; --i) {
            model.predict();
            model.update((code >> i) & 1);
        }
        model.flushByte(code, inBits);
    }

    const reconstructed = [];
    if (inputEndsWithByte !== undefined) {
        let current;
        do {
            current = 0;
            for (let i = inBits - 1; i >= 0; --i) {
                const prob = model.predict();
                const actualBit = decoder.readBit(prob);
                current = (current << 1) | actualBit;
                model.update(actualBit);
            }
            model.flushByte(current, inBits);
            reconstructed.push(current);
        } while (current !== inputEndsWithByte);
    } else {
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
    }

    if (model.release) model.release();
    return reconstructed;
};

//------------------------------------------------------------------------------

// we do not automatically search beyond 9th order for the simpler decoder code
const AUTO_SELECTOR_LIMIT = 512;

export const defaultSparseSelectors = (numContexts = 12) => {
    numContexts = Math.max(0, Math.min(64, numContexts));

    // this was determined from running a simple search against samples,
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

//------------------------------------------------------------------------------

const predictionBytesPerContext = options => (options.precision <= 8 ? 1 : options.precision <= 16 ? 2 : 4);
const countBytesPerContext = options => (options.modelMaxCount < 128 ? 1 : options.modelMaxCount < 32768 ? 2 : 4);

const contextBitsFromMaxMemory = options => {
    const bytesPerContext = predictionBytesPerContext(options) + countBytesPerContext(options);
    let contextBits = floorLog2(options.maxMemoryMB * 1048576, options.sparseSelectors.length * bytesPerContext);

    // the decoder slightly overallocates the memory (~1%) so a naive calculation can exceed the memory limit;
    // recalculate the actual memory usage and decrease contextBits in that case.
    const [, , actualNumContexts] = approximateWithTwoSigDigits(options.sparseSelectors.length << contextBits);
    if (actualNumContexts * bytesPerContext > options.maxMemoryMB * 1048576) --contextBits;

    return contextBits;
};

// String.fromCharCode(...array) is short but doesn't work when array.length is "long enough".
// the threshold is implementation-defined, but 2^16 - epsilon seems common.
const TEXT_DECODER_THRESHOLD = 65000;

const DYN_MODEL_QUOTES = 1;

export class Packer {
    constructor(inputs, options = {}) {
        this.options = {
            sparseSelectors: options.sparseSelectors ? options.sparseSelectors.slice() : defaultSparseSelectors(),
            maxMemoryMB: options.maxMemoryMB || 150,
            precision: options.precision || 16,
            modelMaxCount: options.modelMaxCount || 5,
            modelRecipBaseCount: options.modelRecipBaseCount || 20,
            recipLearningRate: options.recipLearningRate || Math.max(1, 500),
            contextBits: options.contextBits,
            resourcePool: options.resourcePool || options.arrayBufferPool || new ResourcePool(),
            numAbbreviations: typeof options.numAbbreviations === 'number' ? options.numAbbreviations : 64,
            dynamicModels: options.dynamicModels,
            allowFreeVars: options.allowFreeVars,
            disableWasm: options.disableWasm,
        };

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

        if (this.options.dynamicModels === undefined) {
            this.options.dynamicModels = inputs[0].type === 'js' ? DYN_MODEL_QUOTES : 0;
        }
    }

    get memoryUsageMB() {
        const contextBits = this.options.contextBits || contextBitsFromMaxMemory(this.options);
        const [, , numContexts] = approximateWithTwoSigDigits(this.options.sparseSelectors.length << contextBits);
        const bytesPerContext = predictionBytesPerContext(this.options) + countBytesPerContext(this.options);
        return numContexts * bytesPerContext / 1048576;
    }

    static prepareText(inputs) {
        let text = inputs.map(input => input.data).join('');
        if (text.length >= TEXT_DECODER_THRESHOLD || text.match(/[\u0100-\uffff]/)) {
            return { utf8: true, text: unescape(encodeURIComponent(text)) };
        } else {
            return { utf8: false, text };
        }
    }

    static prepareJs(inputs, { dynamicModels, numAbbreviations }) {
        const modelQuotes = dynamicModels & DYN_MODEL_QUOTES;

        // we strongly avoid a token like 'this\'one' because the context model doesn't
        // know about escapes and anything after that would be suboptimally compressed.
        // we can't still avoid something like `foo${`bar`}quux`, where `bar` would be
        // suboptimally compressed, but at least we will return to the normal state at the end.
        const reescape = (s, pattern) => {
            if (modelQuotes) {
                return s.replace(
                    new RegExp(`\\\\?(${pattern})|\\\\.`, 'g'),
                    (m, q) => q ? '\\x' + q.charCodeAt(0).toString(16).padStart(2, '0') : m);
            } else {
                return s;
            }
        };

        const identFreqs = new Map();
        const inputTokens = [];
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
            inputTokens.push(tokens);
        }

        const unseenChars = new Set();
        for (let i = 0; i < 128; ++i) {
            // even though there might be no whitespace in the tokens,
            // we may have to need some space between two namelike tokens later.
            if (i !== 32 && !(modelQuotes && [34, 39, 96].includes(i))) unseenChars.add(String.fromCharCode(i));
        }
        for (const tokens of inputTokens) {
            for (const token of tokens) {
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
        for (const tokens of inputTokens) {
            for (const token of tokens) {
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

    static doPack(preparedText, preparedJs, mainInputAction, options) {
        // TODO if we are to have multiple inputs they have to be splitted
        const combinedInput = [...preparedText.text, ...preparedJs.code].map(c => c.charCodeAt(0));

        const inBits = combinedInput.every(c => c <= 0x7f) ? 7 : 8;
        const outBits = 6;
        // TODO again, this should be controlled dynamically
        const modelQuotes = !!(options.dynamicModels & DYN_MODEL_QUOTES);

        const {
            sparseSelectors, precision, modelMaxCount, modelRecipBaseCount,
            recipLearningRate, allowFreeVars,
        } = options;
        const contextBits = options.contextBits || contextBitsFromMaxMemory(options);

        const compressOptions = { ...options, inBits, outBits, modelQuotes, contextBits };
        const { buf, state, inputLength, bufLengthInBytes, quotesSeen } = compressWithDefaultModel(combinedInput, compressOptions);

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
        const quotes = [...quotesSeen].sort((a, b) => a - b);

        // 2+ decimal points doesn't seem to make any difference after DEFLATE
        const modelBaseCount = { 1: '1', 2: '.5', 5: '.2', 10: '.1' }[modelRecipBaseCount] || `1/${modelRecipBaseCount}`;

        // JS allows \0 but <script> replace it with U+FFFE,
        // so we are fine to use it with eval but not outside.
        const charEscapesInTemplate = {
            // <script> replaces \0 with U+FFFE, so it has to be escaped.
            // but JS itself allows \0 so we don't need additional escapes for eval.
            '\0': '\\0',
            // any \r in template literals is replaced with \n.
            '\r': options.allowFreeVars ? '\\r' : '\\\\r',
            '\\': options.allowFreeVars ? '\\\\' : '\\\\\\\\',
            '`': options.allowFreeVars ? '\\`' : '\\\\`',
        };
        const charEscapesInCharClass = {
            '\0': '\\0',
            '"': options.allowFreeVars ? '"' : '\\"',
            '\r': options.allowFreeVars ? '\\r' : '\\\\r',
            '\n': options.allowFreeVars ? '\\n' : '\\\\n',
            '\\': options.allowFreeVars ? '\\\\' : '\\\\\\\\',
            ']': options.allowFreeVars ? '\\]' : '\\\\]',
        };
        const escapeCharInTemplate = c => charEscapesInTemplate[c] || c;
        const escapeCharInCharClass = c => charEscapesInCharClass[c] || c;

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

        // the decoder consists of three loops and its code order doesn't match
        // with the execution order, which is denoted with the preceding number.
        // for the easier manipulation of variables, every variable is named
        // in green alphabet and only replaced with the actual names at the end.

        const stringifiedInput = utf8 =>
            // if the input length crosses the threshold,
            // the input is either forced to be encoded in UTF-8
            // or (in the case of JS inputs) always in ASCII thus can be decoded as UTF-8.
            utf8 || inputLength >= TEXT_DECODER_THRESHOLD ?
                `new TextDecoder().decode(new Uint8Array(ο))` :
                `String.fromCharCode(...ο)`;

        const pow2 = n => {
            if (n < 10 || n > precision + 10) return '' + (1 << n);
            // make use of θ = 2^(precision+1) as much as possible
            n -= precision + 1;
            if (n < 0) return `θ/${1 << -n}`;
            if (n > 0) return `θ*${1 << n}`;
            return 'θ';
        };

        // only keep two significant digits, rounding up
        const [contextMant, contextExp] = approximateWithTwoSigDigits(numModels << contextBits);
        const contextSize = `${contextMant}e${contextExp}`;

        // 0. first line
        // ι: compressed data, where lowest 6 bits are used and higher bits are chosen to avoid escape sequences.
        // this should be isolated from other code for the best DEFLATE result.
        const sixBit = c => c === 0x1c || c === 0x3f ? c : c | 0x40;
        // the first few bits are the initial state, loaded immediately at the beginning.
        const stateBytes = [];
        let st = state;
        while (st > 0) {
            stateBytes.unshift(st & ((1 << outBits) - 1));
            st >>= outBits;
        }
        let firstLine = `ι='${String.fromCharCode(...stateBytes.map(sixBit))}`;
        const CHUNK_SIZE = 8192;
        for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
            firstLine += String.fromCharCode(...buf.slice(i, i + CHUNK_SIZE).map(sixBit));
        }
        firstLine += `'`;

        // 1. initialize some variables
        // the exact position of initialization depends on the options.
        //
        // θ: common scaling factor
        // ω: weights
        // π: predictions
        // κ: counts
        const secondLineInit = [
            [`θ`, `1<<${precision + 1}`],
            [`ω`, `${JSON.stringify(Array(numModels).fill(0))}`],
            [`π`, `new Uint${predictionBits}Array(${contextSize}).fill(1<<${precision - 1})`],
            [`κ`, `new Uint${countBits}Array(${contextSize})`],
        ];
        if (!options.allowFreeVars) {
            // see step 2 for the description
            secondLineInit.unshift([`ο`, `[]`]);
            secondLineInit.push([`τ`, `0`], [`ρ`, `0`], [`λ`, `0`]);
            if (quotes.length > 0) {
                secondLineInit.push([`χ`, `0`]);
            }
        }

        let secondLine =
            // 2. initialize more variables
            // these can be efficiently initialized in a single statement,
            // but plain arguments are more efficient if the decoder is wrapped with Function.
            //
            // τ: rANS state
            // ο: decoded data
            // ρ: read position in ι
            // λ: write position in ο
            // χ: if in string the quote character code, otherwise 0 (same to state.quote)
            // we know the exact input length, so we don't have the end of data symbol
            `for(${options.allowFreeVars ? `ο=[τ=ρ=λ=${quotes.length > 0 ? 'χ=' : ''}0]` : ''};` +

                // 2. read until the known length
                `λ<${inputLength};` +

            // 9. code to be executed after reading one byte
            (quotes.length > 0 ?
                // ν is now the decode byte plus additional topmost 1 bit, write (and keep) it
                `ο[λ++]=ν-=${1 << inBits}` +

                // update χ according to ν
                `,χ=χ?` +
                    // if we are in ν string we either keep χ or reset to 0 if χ appeared again
                    `ν-χ&&χ:` +
                    // otherwise we set χ to ν if ν is one of opening quotes
                    // (we only process quotes that actually have appeared in the input)
                    (quotes.length > 1 ?
                        `(${quotes.map(q => `ν==${q}`).join('|')})&&ν` :
                        `ν==${quotes[0]}&&ν`)
            :
                // same as above but don't need to keep ν
                `ο[λ++]=ν-${1 << inBits}`
            ) +

            `)` +

            // 3. bitwise read loop
            //
            // ν: bit context, equal to `0b1xx..xx` where xx..xx is currently read bits
            // if ν got more than inBits bits we are done reading one input character
            `for(ν=1;ν<${1 << inBits};` +

                // 6. calculate the mixed prediction Σ
                //
                // δ: context hash
                // μ: model index 
                // α: scratch variable
                // ε: stretched probabilities later used by prediction adjustment
                `ε=φ.map((δ,μ)=>(` +
                    `α=π[δ]*2+1,` +
                    // stretch(prob), needed for updates
                    `α=Math.log(α/(θ-α)),` +
                    `Σ-=ω[μ]*α,` +
                    // premultiply with learning rate
                    `α/${recipLearningRate}` +
                `)),` +

                // 7. read a single bit from the normalized state
                // depends both on step 5 (renormalization) and on step 6 (mixed prediction).
                //
                // Σ: squash(sum of weighted preds) followed by adjustment
                `Σ=~-θ/(1+Math.exp(Σ))|1,` +
                // β: decoded bit
                `β=τ%θ<Σ,` +
                `τ=τ%θ+(β?Σ:θ-Σ)*(τ>>${precision + 1})-!β*Σ,` +

                // 8. update contexts and weights with β and ν (which is now the bit context)
                //
                // δ: context hash
                // μ: model index (unique in the entire code)
                // also makes use of φ and ε below.
                `φ.map((δ,μ)=>(` +
                    // update the bitwise context.
                    // α is not used but used here to exploit a repeated code fragment
                    `α=π[δ]+=` +
                        `(β*${pow2(precision)}-π[δ]<<${29 - precision})/` +
                            `((κ[δ]+=κ[δ]<${modelMaxCount})+${modelBaseCount})` +
                        // this corresponds to delta in the DirectContextModel.update method;
                        // we've already verified delta is within +/-2^31, so `>>>` is not required
                        `>>${29 - precision},` +
                    // update the weight
                    `ω[μ]+=ε[μ]*(β-Σ/θ)` +
                `)),` +
                `ν=ν*2+β` +

            `)` +

            `for(` +

                // 4. calculate context hashes (can be done after 5, but placed here to fill the space)
                // Σ: sum of weighted probabilities
                // φ: an array of context hashes
                (singleDigitSelectors ?
                    `φ='${selectors.map(i => i.join('')).join('0')}'.split(Σ=0)`
                :
                    `Σ=0,φ=${JSON.stringify(selectors)}`
                ) + `.map((δ,μ)=>` +
                    // δ: an array of context offsets (1: last byte, 2: second-to-last byte, ...)
                    // μ: model index 
                    // α: context hash accumulator
                    `(` +
                        `α=0,` +
                        `${singleDigitSelectors ? `[...δ]` : `δ`}.map((δ,μ)=>` +
                            // δ: context offset
                            // redundant argument and parentheses exploit a common code fragment
                            `(α=α*997+(ο[λ-δ]|0)|0)` +
                        `),` +
                        `${pow2(contextBits)}-1&α*997+ν${quotes.length > 0 ? '+!!χ*129' : ''}` +
                    `)*${numModels}+μ` +
                `)` +
            `;` +

                // 5. renormalize (and advance the input offset) if needed
                // this is also used to read the initial state from the input,
                // so has to be placed before step 7 (read a single bit).
                `τ<${pow2(28 - outBits)}` +
            `;` +
                `τ=τ*${1<<outBits}|ι.charCodeAt(ρ++)&${(1 << outBits) - 1}` +
            `);`;

        // 10. postprocessing and action
        // also should clobber π and κ unless they are function arguments,
        // so that the GC can free the memory as soon as possible.
        let outputVar = 'κ'; // can be replaced with assignment statements if possible

        if (!preparedJs.code) {
            outputVar = stringifiedInput(preparedText.utf8);
        } else {
            if (preparedJs.abbrs.length === 0) {
                outputVar = (options.allowFreeVars ? 'κ=π=' : '') + stringifiedInput();
            } else if (preparedJs.abbrs.length < 3) {
                secondLine += `κ=${options.allowFreeVars ? 'π=' : ''}${stringifiedInput()};`;
                for (const [, abbr] of preparedJs.abbrs) {
                    secondLine += `with(κ.split(\`${escapeCharInTemplate(abbr)}\`))` +
                        `κ=join(shift());`;
                }
            } else {
                // character class is probably uncompressible so the shorter one is preferred
                const abbrCharSet = new Set(preparedJs.abbrs.map(([, abbr]) => abbr.charCodeAt(0)));
                const abbrCharClass1 = makeCharClass(abbrCharSet, true);
                const abbrCharClass2 = makeCharClass(abbrCharSet, false);
                const abbrCharClass = (abbrCharClass2.length < abbrCharClass1.length ? abbrCharClass2 : abbrCharClass1);
                secondLine +=
                    `for(κ=${stringifiedInput()};π=/[${abbrCharClass}]/.exec(κ);)` +
                        `with(κ.split(π))` +
                            `κ=join(shift());`;
            }
        }

        const [scopeSensitive, prefix, suffix] = {
            // TODO is it significantly slower than the indirect eval `(0,eval)`?
            'eval': [true, `eval(`, `)`],

            'write': [false, `document.write(`, `)`],

            // undocumented, mainly used for debugging
            'console': [false, `console.log(`, `)`],
            'return': [true, ``, ``],
        }[mainInputAction];

        const placeholderNames =
            'ι' +
            // initialized from function arguments, so should be the first
            secondLineInit.map(([v]) => v).join('') +
            // remaining variables can be in any order
            [...'Σαβδεθκλμνοπρτφχω']
                .filter(v => secondLineInit.every(([w]) => v !== w)).join('');
        const actualNames =
            // should use letters from existing names that we can't remove,
            // so that we can keep the Huffman tree small
            'M' + // from `Math`
            'charCodeAt' +
            'Uiny' + // from `Uint##Array`, the best possible without any further duplicate
            'xp' + // from `exp`
            (quotes.length > 0 ? 'f' : ''); // from `for`

        if (options.allowFreeVars) {
            firstLine += ';';
            secondLine = secondLineInit.map(([v, e]) => `${v}=${e};`).join('') + secondLine + prefix + outputVar + suffix;
        } else {
            // the function call will look like this:
            //   ([M='...',],c,h,a,r,C,o,d,e,...)=>{...})([], /*initial expressions for c, h, ...*/)
            // this is possible because Function arguments are simply concatenated with commas.
            // fun fact: this even allows for `Function('a="foo','bar"','return a')()`!
            firstLine = `Function("[${firstLine}"`;
            secondLine = `,...']${actualNames.slice(1)}',"` + secondLine;
            const args = `[],` + secondLineInit.map(([, e]) => e).join(',');
            if (scopeSensitive) {
                // we can't put the final call into the eval, so we should alter firstLine
                firstLine = prefix + firstLine;
                const needSpace = outputVar.match(/^[A-Za-z0-9_$\u0380-\u03ff]/);
                secondLine += `return${needSpace ? ' ' : ''}${outputVar}")(${args})${suffix}`;
            } else {
                secondLine += `${prefix}${outputVar}${suffix}")(${args})`;
            }
        }

        // remap greek letters to the actual mapping
        const idMap = new Map([...placeholderNames].map((v, i) => [v, actualNames[i]]));
        firstLine = firstLine.replace(/[^\0-\x7f]/g, v => idMap.get(v));
        secondLine = secondLine.replace(/[^\0-\x7f]/g, v => idMap.get(v));

        const boundVars = ['δ', 'μ']; // always local to .map()
        const freeVars = options.allowFreeVars ?
            Object.keys(idMap).filter(v => !boundVars.includes(v)).map(v => idMap[v]).sort() :
            [];

        return {
            firstLine,
            firstLineLengthInBytes: bufLengthInBytes,
            secondLine,
            freeVars,
            maxAbbreviations: preparedJs.maxAbbreviations,
        };
    }

    makeDecoder() {
        const preparedText = Packer.prepareText(this.inputsByType['text'] || [], this.options);
        const preparedJs = Packer.prepareJs(this.inputsByType['js'] || [], this.options);
        const [input] = this.inputsByType['text'] || this.inputsByType['js'];

        const result = Packer.doPack(preparedText, preparedJs, input.action, this.options);

        // so that optimizer doesn't need to try numAbbreviations larger than maxAbbreviations
        if (this.options.numAbbreviations > result.maxAbbreviations) {
            this.options.numAbbreviations = result.maxAbbreviations;
        }

        return new Packed(result);
    }

    async optimize(level, progress) {
        if (typeof level === 'function') {
            progress = level;
            level = 0;
        }
        level = level || 1;

        const performance = await getPerformanceObject();
        const copy = v => JSON.parse(JSON.stringify(v));

        const cache = new Map(); // `${dynamicModels},${numAbbreviations}` -> { preparedText, preparedJs }
        const mainInputAction = (this.inputsByType['text'] || this.inputsByType['js'])[0].action;

        let maxAbbreviations = -1;
        const calculateSize = current => {
            const options = { ...this.options, ...current };

            const key = `${options.dynamicModels},${options.numAbbreviations}`;
            if (!cache.has(key)) {
                const preparedText = Packer.prepareText(this.inputsByType['text'] || [], options);
                const preparedJs = Packer.prepareJs(this.inputsByType['js'] || [], options);
                cache.set(key, { preparedText, preparedJs });
            }

            const { preparedText, preparedJs } = cache.get(key);
            const result = Packer.doPack(preparedText, preparedJs, mainInputAction, options);
            if (maxAbbreviations < 0) maxAbbreviations = result.maxAbbreviations;
            return new Packed(result).estimateLength();
        };

        const reportProgress = async (pass, passRatio, current, currentSize, currentRejected, bestUpdated) => {
            if (!progress) return;

            const info = {
                pass, passRatio,
                current, currentSize, currentRejected,
                best, bestSize, bestUpdated,
            };
            if (await progress(info) === false) throw new Error('search aborted');
        };

        const searchStart = performance.now();

        let best = {};
        let bestSize = calculateSize(best);
        await reportProgress('initial', undefined, best, bestSize, false, true);

        const updateBest = current => {
            const size = calculateSize(current);
            let bestUpdated = false;
            if (size < bestSize) {
                best = copy(current);
                bestSize = size;
                bestUpdated = true;
            }
            return { size, bestUpdated };
        };

        const updateBestAndReportProgress = async (current, pass, passRatio) => {
            const { size: currentSize, bestUpdated } = updateBest(current);
            await reportProgress(pass, passRatio, current, currentSize, !bestUpdated, bestUpdated);
            return currentSize;
        };

        // minimize f(x) assuming x is an integer and there's the global minimum where 0 < lo <= x <= hi.
        // we don't know anything about f'(x), so we use a modified version of binary search
        // where we pick three points in the range and assume that the smallest is closest to the minimum.
        // the way to pick three points depends on the distribution and affects the search performance.
        const EXP = 1;
        const LINEAR = 0;
        const search = async (lo, hi, dist, manualValues, score) => {
            if (level <= 1) {
                for (let i = 0; i < manualValues.length; ++i) {
                    await score(manualValues[i], i / manualValues.length);
                }
                return;
            }

            // this midpoint function should satisfy x < mid(x, y) < y when x + 2 <= y.
            // the linear case is obvious: trunc((x + y) / 2) = x + trunc((y - x) / 2) > x and < y.
            // for the exponential case, it's equivalent to
            //   (x + 1/2)^2 = x^2 + x + 1/4 < x * y < (y - 1/2)^2 = y^2 - y + 1/4.
            // the lower bound is true because x * y = x^2 + x (y - x) >= x^2 + 2x > x^2 + x + 1/4;
            // the upper bound is true because x * y = y^2 - y (y - x) <= y^2 - 2y < y^2 - y + 1/4.
            let mid;
            if (dist === EXP) {
                mid = (x, y) => Math.round(Math.sqrt(x * y));
            } else { // dist === 'linear'
                mid = (x, y) => (x + y) >> 1;
            }

            const cache = new Map();
            // don't ask me about the ratio computation, this is just an approximation
            const origRange = dist === EXP ? Math.log2(hi) - Math.log2(lo) + 1 : hi - lo;
            const evaluate = async x => {
                let y = cache.get(x);
                if (!y) {
                    const range = dist === EXP ? Math.log2(hi) - Math.log2(lo) + 1 : hi - lo;
                    y = await score(x, 1 - Math.log(range) / Math.log(origRange));
                    cache.set(x, y);
                }
                return y;
            };

            let q2 = mid(lo, hi);
            while (hi - lo >= 4) {
                const xx = [lo, mid(lo, q2), q2, mid(q2, hi), hi];
                const yy = [];
                for (const x of xx) yy.push(await evaluate(x));

                let min = 0;
                for (let i = 1; i < 5; ++i) {
                    if (yy[min] > yy[i]) min = i;
                }
                if (min === 0) {
                    hi = xx[1];
                    q2 = mid(lo, hi);
                } else if (min === 4) {
                    lo = xx[3];
                    q2 = mid(lo, hi);
                } else {
                    lo = xx[min - 1];
                    q2 = xx[min];
                    hi = xx[min + 1];
                }
            }
            // make sure that everything in the final range has been evaluated
            for (let x = lo + 1; x < hi; ++x) await evaluate(x);
        };

        // optimize modelRecipBaseCount
        await search(1, 1000, EXP, [10, 20, 50, 100], async (i, ratio) => {
            return await updateBestAndReportProgress({ ...best, modelRecipBaseCount: i }, 'modelRecipBaseCount', ratio);
        });

        // optimize modelMaxCount
        await search(1, 32767, EXP, [4, 5, 6], async (i, ratio) => {
            return await updateBestAndReportProgress({ ...best, modelMaxCount: i }, 'modelMaxCount', ratio);
        });
        if (best.modelMaxCount === this.options.modelMaxCount) delete best.modelMaxCount;

        // optimize dynamicModels
        for (let i = 0; i < 2; ++i) {
            await updateBestAndReportProgress({ ...best, dynamicModels: i }, 'dynamicModels', i / 2);
        }
        if (best.dynamicModels === this.options.dynamicModels) delete best.dynamicModels;

        // optimize numAbbreviations
        await search(0, maxAbbreviations, LINEAR, [0, 16, 32, 64], async (i, ratio) => {
            return await updateBestAndReportProgress({ ...best, numAbbreviations: i }, 'numAbbreviations', ratio);
        });
        if (best.numAbbreviations === this.options.numAbbreviations) delete best.numAbbreviations;

        // optimize sparseSelectors by simulated annealing
        let current = this.options.sparseSelectors.slice();
        let currentSize = bestSize;
        const taboo = new Map();
        let temperature = 1;
        const targetTemperature = level >= 2 ? 0.1 : 0.9;
        while (temperature > targetTemperature) {
            const next = current.slice();

            let added;
            do {
                added = Math.random() * AUTO_SELECTOR_LIMIT | 0;
            } while (next.includes(added));
            next[Math.random() * next.length | 0] = added;
            next.sort((a, b) => a - b);

            const { size: nextSize, bestUpdated } = updateBest({ ...best, sparseSelectors: next });
            // if nextSize > currentSize then accept by some probability exp(delta / kT) < 1
            const rejected = Math.exp((currentSize - nextSize) / (6 * temperature)) < Math.random();
            await reportProgress(
                'sparseSelectors', Math.log(temperature) / Math.log(targetTemperature),
                { ...best, sparseSelectors: next }, nextSize,
                rejected, bestUpdated);
            if (!rejected) {
                current = next;
                currentSize = nextSize;
            }

            temperature *= 0.99;
        }

        // optimize precision
        await search(1, 21, LINEAR, [12, 14, 16], async (i, ratio) => {
            return await updateBestAndReportProgress({ ...best, precision: i }, 'precision', ratio);
        });
        if (best.precision === this.options.precision) delete best.precision;

        // optimize recipLearningRate
        await search(1, 99999, EXP, [500, 750, 1000, 1250, 1500], async (i, ratio) => {
            return await updateBestAndReportProgress({ ...best, recipLearningRate: i }, 'recipLearningRate', ratio);
        });
        if (best.recipLearningRate === this.options.recipLearningRate) delete best.recipLearningRate;

        // apply the final result to this
        this.options = { ...this.options, ...best };
        return { elapsedMsecs: performance.now() - searchStart, best, bestSize };
    }
}

class Packed {
    constructor({ firstLine, firstLineLengthInBytes, secondLine, freeVars }) {
        this.firstLine = firstLine;
        this.firstLineLengthInBytes = firstLineLengthInBytes;
        this.secondLine = secondLine;
        this.freeVars = freeVars;
    }

    estimateLength() {
        // the first line is mostly 6-bit code, but there are additional characters
        // so one of the 6-bit code literal has to be encoded in 7 bits.
        // if the original data is N bytes the first line will contain about 4/3 N codes,
        // 1/64 of which will have to use one additional bit.
        // therefore the estimated overhead is 4/3 N * 1/64 [bits] = N/384 [bytes].
        // we then add the number of "incompressible" (>= 7 bits) bytes from the first line;
        // the final additional 35 bytes are experimentally derived from the Huffman tree coding.
        const incompressibleFirstLineLength = this.firstLine.replace(/[\x1c\x3f-\x7e]/g, '').length;
        return (35 +
            incompressibleFirstLineLength +
            Math.ceil(this.firstLineLengthInBytes * (1 + 1/384)) +
            estimateDeflatedSize(this.secondLine));
    }
}

