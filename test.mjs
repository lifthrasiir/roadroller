import test from 'ava';
import * as crypto from 'crypto';
import {
    ResourcePool, AnsEncoder, AnsDecoder, DirectContextModel, DefaultModel, Packer,
    compressWithModel, compressWithDefaultModel, decompressWithModel
} from './index.mjs';

//------------------------------------------------------------------------------

// a direct port of pcg32_srandom_r + pcg32_random_r
// AVA runs tests in multiple threads, so we need a seeded RNG
function makePcg32(initState, initSeq) {
    const mask64 = (1n << 64n) - 1n;
    const mask32 = (1n << 32n) - 1n;
    initState = BigInt(initState);
    let state = initState;
    let inc = BigInt(initSeq) << 1n | 1n;
    const random = () => {
        const oldState = state;
        state = (oldState * 6364136223846793005n + inc) & mask64;
        const xorshifted = (((oldState >> 18n) ^ oldState) >> 27n) & mask32;
        const rot = oldState >> 59n;
        return Number((xorshifted >> rot) | ((xorshifted << ((-rot) & 31n)) & mask32));
    };
    random();
    state = (state + initState) & mask64;
    random();
    return random;
}

test('PCG32 generator', t => {
    const random = makePcg32(12345, 67890);
    const seen = new Set();
    for (let i = 0; i < 100; ++i) {
        const v = random();
        t.assert(0 <= v && v <= 0xffffffff);
        seen.add(v);
    }
    t.is(seen.size, 100); // no duplicates
});

//------------------------------------------------------------------------------

function testAnsRoundtrip(outBits, precision) {
    test(`ans round-trip (outBits ${outBits}, precision ${precision})`, t => {
        const options = { outBits, precision };

        let bits = t.context.randomBits;
        if (!bits) {
            bits = t.context.randomBits = [];
            const random = makePcg32(9275837109, 1);
            for (let i = 0; i < 100000; ++i) {
                const rand = random();
                const bit = rand & 1;
                const pred = rand >>> 1;
                bits.push({ bit, pred });
            }
        }

        const encoder = new AnsEncoder(options);
        for (const { bit, pred } of bits) {
            const freq = pred >> (31 - precision);
            encoder.writeBit(bit, freq);
        }
        const { state, buf, bufLenInBytes } = encoder.finish();
        const numSymbols = outBits < 0 ? -outBits : 1 << outBits;
        t.assert(buf.every(c => 0 <= c && c < numSymbols));

        const decoder = new AnsDecoder({ state, buf }, options);
        for (const { bit, pred } of bits) {
            const freq = pred >> (31 - precision);
            const decodedBit = decoder.readBit(freq);
            t.is(bit, decodedBit);
        }

        // there should be no very significant performance decrease
        if (t.context.randomBitsCompressedLenInBytes) {
            t.assert(Math.abs(t.context.randomBitsCompressedLenInBytes - bufLenInBytes) < 20);
        } else {
            t.context.randomBitsCompressedLenInBytes = bufLenInBytes;
        }
    });
}

testAnsRoundtrip(5, 16);
testAnsRoundtrip(6, 16);
testAnsRoundtrip(7, 16);
testAnsRoundtrip(8, 16);
testAnsRoundtrip(8, 12);

// non-power-of-two outBits should equally work
testAnsRoundtrip(-10, 16);
testAnsRoundtrip(-33, 16);
testAnsRoundtrip(-96, 16);
testAnsRoundtrip(-345, 16);
testAnsRoundtrip(-1000, 16);

//------------------------------------------------------------------------------

class SimpleModel {
    constructor({ inBits, precision }) {
        this.inBits = inBits;
        this.precision = precision;
        this.ones = this.zeroes = 1;
    }

    predict() {
        return (this.ones / (this.ones + this.zeroes)) * (1 << this.precision) | 0;
    }

    update(actualBit) {
        if (actualBit) {
            ++this.ones;
        } else {
            ++this.zeroes;
        }
    }

    flushByte(currentByte, inBits) {
    }
}

class CheckedSimpleModel extends SimpleModel {
    constructor(t, options) {
        super(options);
        this.t = t;
        this.bitsSinceFlush = 0;
        this.numBitsSinceFlush = 0;
    }

    update(actualBit) {
        super.update(actualBit);
        this.bitsSinceFlush = (this.bitsSinceFlush << 1) | actualBit;
        ++this.numBitsSinceFlush;
        this.t.assert(this.numBitsSinceFlush <= this.inBits);
    }

    flushByte(currentByte, inBits) {
        super.flushByte(currentByte, inBits);
        this.t.is(inBits, this.inBits);
        this.t.is(inBits, this.numBitsSinceFlush);
        this.t.is(currentByte, this.bitsSinceFlush);
        this.numBitsSinceFlush = 0;
        this.bitsSinceFlush = 0;
    }

    check(input) {
        this.t.is(this.numBitsSinceFlush, 0);
        this.t.is(this.bitsSinceFlush, 0);

        let actualOnes = 0;
        let actualZeroes = 0;
        for (const v of input) {
            for (let i = 0; i < this.inBits; ++i) {
                if ((v >> i) & 1) ++actualOnes; else ++actualZeroes;
            }
        }
        this.t.is(this.ones, actualOnes + 1);
        this.t.is(this.zeroes, actualZeroes + 1);
    }
}

class CheckedSimpleModelWithRelease extends CheckedSimpleModel {
    constructor(t, options) {
        super(t, options);
        this.released = false;
    }

    release() {
        if (this.released) throw 'CheckedSimpleModelWithRelease.release has been called twice';
        this.released = true;
    }

    check(input) {
        super.check(input);
        this.t.assert(this.released);
    }
}

// make sure to NOT use double quotes here, used by the DefaultModel test
function testCompressWithModel(input, inputDesc, expectedCompressedSize, modelClass) {
    input = [...input].map(c => c.charCodeAt(0));
    if (!input.every(c => c <= 0xff)) throw 'testCompressWithModel: input should be 8-bit';

    test(`compress with ${modelClass.name} (${inputDesc})`, t => {
        const options = { inBits: 8, outBits: 8, precision: 12 };
        let model;

        model = new modelClass(t, options);
        const compressed = compressWithModel(input, model, options);
        t.assert(compressed.buf.every(v => 0 <= v && v < (1 << options.outBits)));
        model.check(input);

        t.assert(
            Math.abs(expectedCompressedSize - compressed.buf.length) < 100,
            `compressed size deviates (expected ${expectedCompressedSize}, actual ${compressed.buf.length})`);

        model = new modelClass(t, options);
        const decompressed = decompressWithModel(compressed, model, options);
        t.deepEqual(decompressed, input);
        model.check(input);
    });
}

testCompressWithModel('hello, world!', 'short string', 13, CheckedSimpleModel);
testCompressWithModel('hello, world!', 'short string', 13, CheckedSimpleModelWithRelease);

// this will result in the maximum probability around 4000th bits
testCompressWithModel('\xff'.repeat(10000), 'all ones', 1, CheckedSimpleModel);
testCompressWithModel('\0'.repeat(10000), 'all zeroes', 1, CheckedSimpleModel);

testCompressWithModel('\x55'.repeat(10000), 'repeating ones & zeroes', 10000, CheckedSimpleModel);

// test if the encoder still works at the extreme probability;
// since there would be 1/2^precision probability ten times,
// the expected size would be around precision * 10 = 120 bits
const veryRareZeroes = ('\xff'.repeat(10000) + '\xfe').repeat(10);
testCompressWithModel(veryRareZeroes, 'very rare zeroes', 15, CheckedSimpleModel);

test('inputEndsWithByte', t => {
    const options = {
        inBits: 8,
        outBits: 8,
        precision: 16,
        contextBits: 10,
        modelMaxCount: 63,
    };

    for (const lastByte of [0, 1, 255]) {
        options.inputEndsWithByte = lastByte;

        for (const input of [
            [lastByte],
            [lastByte === 1 ? 0 : 1, lastByte],
            [lastByte === 255 ? 0 : 255, lastByte],
            [1, 2, 3, 0].map(i => (lastByte + i) & 255),
        ]) {
            const compressed = compressWithModel(input, new DirectContextModel(options), options);
            t.is(compressed.inputLength, -1);
            const decompressed = decompressWithModel(compressed, new DirectContextModel(options), options);
            t.deepEqual(decompressed, input);
        }

        // make sure that an input with the incorrect last byte or
        // a stream that is compressed without inputEndsWithByte triggers an error
        for (const input of [
            [],
            [lastByte ^ 1],
            [lastByte, lastByte],
            [!lastByte | 0, lastByte, !lastByte | 0, lastByte],
        ]) {
            t.throws(() => compressWithModel(input, new DirectContextModel(options), options));

            if (input[input.length - 1] !== lastByte) {
                const otherOptions = { ...options, inputEndsWithByte: undefined };
                const compressed = compressWithModel(input, new DirectContextModel(options), otherOptions);
                t.throws(() => decompressWithModel(compressed, new DirectContextModel(options), options));
            }
        }
    }
});

//------------------------------------------------------------------------------

const testCode = testCompressWithModel.toString();

function testDefaultModel(title, modelQuotes) {
    test(title, async t => {
        const input = [...testCode].map(c => c.charCodeAt(0));

        const options = {
            inBits: 7,
            outBits: 8,
            sparseSelectors: [0, 1, 2, 3, 4],
            contextBits: 12,
            precision: 16,
            modelMaxCount: 63,
            modelRecipBaseCount: 20,
            recipLearningRate: 256,
            modelQuotes,
        };
        let model;

        model = new DefaultModel(options);
        const compressed = compressWithModel(input, model, options);

        // the code should compress very well, otherwise it went horribly wrong
        const ratio = compressed.bufLengthInBytes / input.length;
        t.assert(ratio < 0.5);

        model = new DefaultModel(options);
        const decompressed = decompressWithModel(compressed, model, options);
        t.deepEqual(decompressed, input);

        t.deepEqual(model.quotesSeen, new Set(modelQuotes ? [39, 96] : []));

        // test compressWithDefaultModel as well
        for (const disableWasm of [true, false]) {
            // the wasm result should not only decompress correctly, but also
            // be identical to the non-wasm result so that the compression
            // ratio is never affected.
            options.disableWasm = disableWasm;
            const compressed2 = compressWithDefaultModel(input, options);
            t.deepEqual(compressed2.state, compressed.state);
            t.deepEqual(compressed2.buf, compressed.buf);
            t.deepEqual(compressed2.quotesSeen, model.quotesSeen);
        }
    });
}

testDefaultModel('DefaultModel', false);
testDefaultModel('DefaultModel modelQuotes', true);

// subsequent Packer tests will internally use compressWithDefaultModel.

//------------------------------------------------------------------------------

test('DirectContextModel.confirmations', t => {
    const resourcePool = new ResourcePool();
    const options = {
        inBits: 8,
        outBits: 8,
        precision: 16,
        contextBits: 5, // 32 elements
        modelMaxCount: 63,
        resourcePool,
    };

    // the size of 1 will set ~8 elements and test for partial fills.
    // the size of 10 will set all 32 elements with >92% probability and test for total fills.
    for (const size of [1, 10]) {
        // this ensures that we cycle through multiple confirmation resets
        for (let i = 0; i < 1000; ++i) {
            const input = [...crypto.randomBytes(size)];
            const compressed = compressWithModel(input, new DirectContextModel(options), options);
            const decompressed = decompressWithModel(compressed, new DirectContextModel(options), options);
            t.deepEqual(decompressed, input);
        }
    }
});

test('DefaultModel.confirmations', t => {
    // same as above, but tests the wasm version
    const resourcePool = new ResourcePool();
    const options = {
        inBits: 8,
        outBits: 8,
        precision: 8, // additionally required to trigger the mark overflow within 256 tries
        contextBits: 5, // 32 elements
        modelMaxCount: 63,
        sparseSelectors: [0, 1, 2, 3, 4],
        modelRecipBaseCount: 20,
        recipLearningRate: 256,
        modelQuotes: false,
        resourcePool,
    };

    for (const size of [1, 10]) {
        for (let i = 0; i < 1000; ++i) {
            const input = [...crypto.randomBytes(size)];
            const compressed = compressWithDefaultModel(input, options);
            const decompressed = decompressWithModel(compressed, new DefaultModel(options), options);
            t.deepEqual(decompressed, input);
        }
    }
});

//------------------------------------------------------------------------------

test('prepareJs without abbrs', t => {
    const prepare = data => Packer.prepareJs([{ data }], { numAbbreviations: 0 }).code;
    t.is(prepare(`hello`), `hello`);
    t.is(prepare(`  3 + 4\n\n + 5   \n`), `3+4\n+5`);
    t.is(prepare(`foo\`bar\nquux\``), `foo\`bar\nquux\``);
    t.is(prepare(`안능하제옇 \\u314e`), `\\uc548\\ub2a5\\ud558\\uc81c\\uc607 \\u314e`);
    t.is(prepare(`3 + + 4 - - 5 / /asdf/`), `3+ +4- -5/ /asdf/`);
    t.is(prepare(`/asdf/ in {}`), `/asdf/ in{}`);
    t.is(prepare(`switch (3) { case 3: ; }`), `switch(3){case 3:;}`);
    t.is(prepare(`switch (3) { case .3: ; }`), `switch(3){case.3:;}`);
    t.is(prepare(`switch (3) { case ㅎ: ; }`), `switch(3){case \\u314e:;}`);
    t.is(prepare(`for (const a of $tuffs) {}`), `for(const a of $tuffs){}`);
});

//------------------------------------------------------------------------------

function pack(data, options = {}) {
    const type = options.type || 'js';
    const action = options.action || 'eval';
    const packer = new Packer([{ type, action, data }], { maxMemoryMB: 10, ...options });
    return packer.makeDecoder();
}

function packAndEval(data, options = {}) {
    const { firstLine, secondLine, freeVars } = pack(data, options);
    // Roadroller outputs use `with`, so we need to break the strictness inheritance with Function
    return Function('code', 'return eval(code)')(
        `var unused${freeVars.map(v => ',' + v).join('')};${firstLine}${secondLine}`);
}

function packAndReturn(data, options = {}) {
    return packAndEval(data, { action: 'return', ...options });
}

test('Packer', t => {
    t.is(packAndEval('3 + 4 * 5'), 23);
    t.is(packAndReturn('3 + 4 * 5'), '3+4*5');

    // allowFreeVars
    const cleanlyPacked = pack('3 + 4 * 5', { allowFreeVars: true });
    t.deepEqual(cleanlyPacked.freeVars, []);
    t.is(packAndEval('3 + 4 * 5', { allowFreeVars: true }), 23);
    t.is(packAndReturn('3 + 4 * 5', { allowFreeVars: true }), '3+4*5');
});

test('abbreviations', t => {
    t.is(packAndEval(`
        const alpha = 42;
        alpha + alpha + alpha + alpha + alpha
    `), 42 * 5);
    t.is(packAndEval(`
        const alpha = 42, beta = 54;
        (alpha + alpha + alpha + alpha + alpha) * (beta + beta + beta + beta)
    `), 42 * 5 * 54 * 4);
    t.is(packAndEval(`
        const alpha = 42, beta = 54, gamma = 13;
        (alpha + alpha + alpha + alpha + alpha) * (beta + beta + beta + beta) * (gamma + gamma + gamma)
    `), 42 * 5 * 54 * 4 * 13 * 3);

    // any number of abbreviations should work
    const names = [];
    for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$') {
        names.push(c.repeat(5));
        t.is(packAndEval(`let ${(names.join(',') + ';').repeat(5)}${names.length}`), names.length);
    }
});

test('reescaping', t => {
    const examples = [
        ['"asdf\'asdf"', '"asdf\'asdf"'],
        ['"asdf\\"asdf"', '"asdf\\x22asdf"'],
        ['"asdf\\\'asdf"', '"asdf\\\'asdf"'],
        ['"asdf\\\"asdf"', '"asdf\\x22asdf"'],
        ['"asdf\\\\\'asdf"', '"asdf\\\\\'asdf"'],
        ["'asdf\"asdf'", "'asdf\"asdf'"],
        ["'asdf\\'asdf'", "'asdf\\x27asdf'"],
        ["'asdf\\\"asdf'", "'asdf\\\"asdf'"],
        ["'asdf\\\'asdf'", "'asdf\\x27asdf'"],
        ["'asdf\\\\\"asdf'", "'asdf\\\\\"asdf'"],
        ['`asdf\\\`asdf`', '`asdf\\x60asdf`'],
        ['`asdf\\\\\\\`asdf`', '`asdf\\\\\\x60asdf`'],
        ['`foo\\\`${`asdf\\\\\\\`asdf`}\\\`bar`', '`foo\\x60${`asdf\\\\\\x60asdf`}\\x60bar`'],
        ['/[\'"`]/g', '/[\\x27\\x22\\x60]/g'],
        ['/[\\\'\\"\\`]/g', '/[\\x27\\x22\\x60]/g'],
    ];

    for (const [input, reescaped] of examples) {
        // we don't need to reescape literals if we are not affected by quotes model anyway
        t.is(packAndReturn(input, { dynamicModels: 0 }), input);
        t.is(packAndReturn(input, { dynamicModels: 1 }), reescaped);
    }
});

const LONG_ENOUGH_INPUT = 100000; // ...so that an alternative code path is triggered

test('Packer with long inputs', t => {
    t.is(packAndEval(';'.repeat(LONG_ENOUGH_INPUT) + '42', { sparseSelectors: [0] }), 42);
    t.is(packAndEval(';'.repeat(LONG_ENOUGH_INPUT) + '"×"', { sparseSelectors: [0] }), '×');
    t.is(packAndEval(';'.repeat(LONG_ENOUGH_INPUT) + '"ㅋ"', { sparseSelectors: [0] }), 'ㅋ');
});

test('Packer with very high order context', t => {
    t.is(packAndEval('3 + 4 * 5', { sparseSelectors: [511] }), 23);
    t.is(packAndEval('3 + 4 * 5', { sparseSelectors: [512] }), 23);
});

test('Packer with high entropy', t => { // also test long inputs
    let data = '';
    while (data.length < LONG_ENOUGH_INPUT) {
        data += String.fromCharCode(...crypto.randomBytes(1 << 12));
    }
    // we've got 100 KB of random data, which can't be really compressed
    t.is(packAndReturn(data, { type: 'text', sparseSelectors: [0] }), data);
});

test('parameter agility', t => {
    // this also tests the versaatility of wasm implementation,
    // which may work initially but fail subsequently due to the previous memory.
    // following parameters specifically vary the memory layout for testing.
    t.is(packAndEval('3 + 4 * 5', { sparseSelectors: [0, 511] }), 23);
    t.is(packAndEval('3 + 4 * 5', { sparseSelectors: [511] }), 23);
    t.is(packAndEval('3 + 4 * 5', { sparseSelectors: [511, 512, 513] }), 23);
    t.is(packAndEval('3 + 4 * 5', { maxMemoryMB: 1, sparseSelectors: [511, 512, 513] }), 23);
    t.is(packAndEval('3 + 4 * 5', { maxMemoryMB: 5, sparseSelectors: [511, 512, 513] }), 23);

    t.is(packAndEval('3 + 4 * 5', { precision: 1 }), 23);
    t.is(packAndEval('3 + 4 * 5', { precision: 21 }), 23);
    t.is(packAndEval('3 + 4 * 5', { modelMaxCount: 1 }), 23);
    t.is(packAndEval('3 + 4 * 5', { modelMaxCount: 32767 }), 23);
});

