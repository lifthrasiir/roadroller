import test from 'ava';
import * as crypto from 'crypto';
import {
    AnsEncoder, AnsDecoder, DefaultModel, Packer,
    compressWithModel, decompressWithModel
} from './index.js';

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
        t.assert(buf.every(c => 0 <= c && c < (1 << outBits)));

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

//------------------------------------------------------------------------------

class SimpleModel {
    constructor(t, { inBits, precision }) {
        this.t = t;
        this.inBits = inBits;
        this.precision = precision;
        this.ones = this.zeroes = 1;
        this.bitsSinceFlush = 0;
        this.numBitsSinceFlush = 0;
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
        this.bitsSinceFlush = (this.bitsSinceFlush << 1) | actualBit;
        ++this.numBitsSinceFlush;
        this.t.assert(this.numBitsSinceFlush <= this.inBits);
    }

    flushByte(currentByte, inBits) {
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

class SimpleModelWithRelease extends SimpleModel {
    constructor(t, options) {
        super(t, options);
        this.released = false;
    }

    release() {
        if (this.released) throw 'SimpleModelWithRelease.release has been called twice';
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

testCompressWithModel('hello, world!', 'short string', 13, SimpleModel);
testCompressWithModel('hello, world!', 'short string', 13, SimpleModelWithRelease);

// this will result in the maximum probability around 4000th bits
testCompressWithModel('\xff'.repeat(10000), 'all ones', 1, SimpleModel);
testCompressWithModel('\0'.repeat(10000), 'all zeroes', 1, SimpleModel);

testCompressWithModel('\x55'.repeat(10000), 'repeating ones & zeroes', 10000, SimpleModel);

// test if the encoder still works at the extreme probability;
// since there would be 1/2^precision probability ten times,
// the expected size would be around precision * 10 = 120 bits
const veryRareZeroes = ('\xff'.repeat(10000) + '\xfe').repeat(10);
testCompressWithModel(veryRareZeroes, 'very rare zeroes', 15, SimpleModel);

//------------------------------------------------------------------------------

const testCode = testCompressWithModel.toString();

test('compress with DefaultModel', t => {
    const input = [...testCode].map(c => c.charCodeAt(0));

    const options = {
        inBits: 7,
        outBits: 8,
        sparseSelectors: [0, 1, 2, 3, 4],
        contextBits: 12,
        precision: 16,
        modelMaxCount: 63,
        learningRateNum: 1,
        learningRateDenom: 256,
        modelQuotes: true,
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

    t.deepEqual(model.quotesSeen, new Set([39, 96]));
});

//------------------------------------------------------------------------------

test('prepareJs without abbrs', t => {
    const prepare = data => Packer.prepareJs([{ data }], { minFreqForAbbrs: Infinity }).code;
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

function packAndEval(data, options = {}) {
    const type = options.type || 'js';
    const action = options.action || 'eval';
    const packer = new Packer([{ type, action, data }], { maxMemoryMB: 10, ...options });
    const { firstLine, secondLine } = packer.makeDecoder();

    // XXX this is only okay-ish because we know the decoder internals
    const possibleVars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    // Function doesn't inherit the strictness, which is required for Roadroller outputs
    return Function('code', 'return eval(code)')(`let ${[...possibleVars].join(',')};${firstLine};${secondLine}`);
}

function packAndReturn(data, options = {}) {
    return packAndEval(data, { action: 'return', ...options });
}

test('Packer', t => {
    t.is(packAndEval('3 + 4 * 5'), 23);
    t.is(packAndReturn('3 + 4 * 5'), '3+4*5');
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
});

test('reescaping', t => {
    t.is(packAndReturn('"asdf\'asdf"'), '"asdf\'asdf"');
    t.is(packAndReturn('"asdf\\"asdf"'), '"asdf\\x22asdf"');
    t.is(packAndReturn('"asdf\\\'asdf"'), '"asdf\\\'asdf"');
    t.is(packAndReturn('"asdf\\\"asdf"'), '"asdf\\x22asdf"');
    t.is(packAndReturn('"asdf\\\\\'asdf"'), '"asdf\\\\\'asdf"');
    t.is(packAndReturn("'asdf\"asdf'"), "'asdf\"asdf'");
    t.is(packAndReturn("'asdf\\'asdf'"), "'asdf\\x27asdf'");
    t.is(packAndReturn("'asdf\\\"asdf'"), "'asdf\\\"asdf'");
    t.is(packAndReturn("'asdf\\\'asdf'"), "'asdf\\x27asdf'");
    t.is(packAndReturn("'asdf\\\\\"asdf'"), "'asdf\\\\\"asdf'");
    t.is(packAndReturn('`asdf\\\`asdf`'), '`asdf\\x60asdf`');
    t.is(packAndReturn('`asdf\\\\\\\`asdf`'), '`asdf\\\\\\x60asdf`');
    t.is(packAndReturn('`foo\\\`${`asdf\\\\\\\`asdf`}\\\`bar`'), '`foo\\x60${`asdf\\\\\\x60asdf`}\\x60bar`');
    t.is(packAndReturn('/[\'"`]/g'), '/[\\x27\\x22\\x60]/g');
    t.is(packAndReturn('/[\\\'\\"\\`]/g'), '/[\\x27\\x22\\x60]/g');
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

