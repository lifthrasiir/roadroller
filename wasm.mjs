// Roadroller: Flattens your JS demo
// Copyright (c) 2021 Kang Seonghoon. See LICENSE.txt for details.

export const getContextItemShift = ({ precision, modelMaxCount }) =>
    Math.max(
        precision <= 8 ? 0 : precision <= 16 ? 1 : 2,
        modelMaxCount < 128 ? 0 : modelMaxCount < 32768 ? 1 : 2);

// this is a WebAssembly version of compressWithModel with a DefaultModel,
// minus AnsEncoder (which should be run independently with returned probabilities).
// this should return an *identical* result to the JS version.
export const makeDefaultModelRunner = contextItemShift => {
    if (!(0 <= contextItemShift && contextItemShift <= 2)) throw 'bad contextItemShift';

    // when turned on, can use `call(F_PRINT_I32/F64, ...)` to print a value.
    // they are ignored (i.e. no instructions are generated) when DEBUG is turned off.
    const DEBUG = false;

    const vec = (...a) => [~a.length].concat(...a.map(e => Array.isArray(e) ? e : [e]));

    const signed = v => {
        const bytes = [];
        while (v > 0x3f || v < -0x40) {
            bytes.push(v & 0x7f | 0x80);
            v >>= 7;
        }
        bytes.push(v & 0x7f);
        return bytes;
    };

    const binary64 = v => {
        const a = new Uint8Array(8);
        new DataView(a.buffer).setFloat64(0, v, true);
        return [...a];
    };

    const ensure_i32 = a => {
        if (a === undefined) throw 'i32 argument missing';
        return Array.isArray(a) ? a : i32(a);
    };
    const ensure_i64 = a => {
        if (a === undefined) throw 'i64 argument missing';
        return Array.isArray(a) ? a : i64(a);
    };
    const ensure_f64 = a => {
        if (a === undefined) throw 'f64 argument missing';
        return Array.isArray(a) ? a : f64(a);
    };

    const I32 = 0x7f;
    const I64 = 0x7e;
    const F32 = 0x7d;
    const F64 = 0x7c;

    const END = 0x0b;
    const loop = (...body) => [0x03, 0x40].concat(...body, [END]);
    const if_ = (cond, ...body) => [...cond, 0x04, 0x40].concat(...body, [END]);
    const if_else = (cond, ...thenBody) => (...elseBody) => [...cond, 0x04, 0x40].concat(...thenBody, [0x05], ...elseBody, [END]);
    const call = (f, ...args) => f < 0 ? [] : [].concat(...args, [0x10, ~f]);
    const select = (cond, a, b) => [...a, ...b, ...cond, 0x1b];
    const br_if = (depth, v) => [...v, 0x0d, ~depth];
    const /*local_*/get = l => [0x20, ~l];
    const /*local_*/set = (l, v) => [...ensure_i32(v), 0x21, ~l];
    const /*local_*/tee = (l, v) => [...ensure_i32(v), 0x22, ~l];
    const /*i32_*/load32 = (offset, addr) => [...addr, 0x28, ~2 /*align*/, ~offset];
    const /*i64_*/load64 = (offset, addr) => [...addr, 0x29, ~3 /*align*/, ~offset];
    const /*f64_*/fload = (offset, addr) => [...addr, 0x2b, ~3 /*align*/, ~offset];
    const /*i32_*/load8_u = (offset, addr) => [...addr, 0x2d, ~0 /*align*/, ~offset];
    const /*i32_*/load16_u = (offset, addr) => [...addr, 0x2f, ~1 /*align*/, ~offset];
    const /*i32_*/store32 = (offset, addr, v) => [...addr, ...ensure_i32(v), 0x36, ~2 /*align*/, ~offset];
    const /*f64_*/fstore = (offset, addr, v) => [...addr, ...ensure_f64(v), 0x39, ~3 /*align*/, ~offset];
    const /*i32_*/store8 = (offset, addr, v) => [...addr, ...ensure_i32(v), 0x3a, ~0 /*align*/, ~offset];
    const /*i32_*/store16 = (offset, addr, v) => [...addr, ...ensure_i32(v), 0x3b, ~1 /*align*/, ~offset];
    const i32/*_const*/ = v => [0x41, ...signed(v | 0)];
    const i64/*_const*/ = v => [0x42, ...signed(v | 0)];
    const f64/*_const*/ = v => [0x44, ...binary64(v)];
    const /*i32_*/eq = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x46];
    const /*i32_*/ne = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x47];
    const /*i32_*/lt_u = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x49];
    const /*i32_*/ge_s = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x4e];
    const i64_gt_u = (a, b) => [...ensure_i64(a), ...ensure_i64(b), 0x56];
    const /*i32_*/add = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x6a];
    const /*i32_*/sub = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x6b];
    const /*i32_*/mul = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x6c];
    const /*i32_*/and = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x71];
    const /*i32_*/or = (a, b) => [...ensure_i32(a), ...ensure_i32(b), 0x72];
    const /*i32_*/shl = (v, shift) => [...ensure_i32(v), ...ensure_i32(shift), 0x74];
    const /*i32_*/shr_s = (v, shift) => [...ensure_i32(v), ...ensure_i32(shift), 0x75];
    const /*i32_*/shr_u = (v, shift) => [...ensure_i32(v), ...ensure_i32(shift), 0x76];
    const i64_shr_u = (v, shift) => [...ensure_i64(v), ...ensure_i64(shift), 0x88];
    const /*f64_*/fadd = (a, b) => [...ensure_f64(a), ...ensure_f64(b), 0xa0];
    const /*f64_*/fsub = (a, b) => [...ensure_f64(a), ...ensure_f64(b), 0xa1];
    const /*f64_*/fmul = (a, b) => [...ensure_f64(a), ...ensure_f64(b), 0xa2];
    const /*f64_*/fdiv = (a, b) => [...ensure_f64(a), ...ensure_f64(b), 0xa3];
    const i32_wrap_i64 = v => [...ensure_i64(v), 0xa7];
    const i32_trunc_f64_s = v => [...ensure_f64(v), 0xaa];
    const i32_trunc_f64_u = v => [...ensure_f64(v), 0xab];
    const f64_convert_i32_s = v => [...ensure_i32(v), 0xb7];
    const f64_convert_i32_u = v => [...ensure_i32(v), 0xb8];
    const memory_fill = (addr, v, n) => [...ensure_i32(addr), ...ensure_i32(v), ...ensure_i32(n), 0xfc, 0x0b, 0x00];

    const loadContextItem = [load8_u, load16_u, load32][contextItemShift];
    const storeContextItem = [store8, store16, store32][contextItemShift];

    // functions
    let funcCount = 0;
    const F_LOG = funcCount++;
    const F_EXP = funcCount++;
    const F_PRINT_I32 = DEBUG ? funcCount++ : -1;
    const F_PRINT_F64 = DEBUG ? funcCount++ : -1;
    const F_RUN = funcCount++;

    // memory offsets
    //
    // i64[64], input
    // each non-zero nibble is an offset to the context byte
    const M_SELECTORS = 0;
    // i32[64], scratch
    // the portion of M_CONTEXTHASH which is same across the current byte
    const M_CONTEXTPARTIALHASH = 0x200;
    // i32[64], scratch
    const M_CONTEXTHASH = 0x300;
    // i32[64], scratch
    const M_PREDICTIONS = 0x400;
    // f64[64], scratch
    const M_WEIGHTS = 0x500;
    // i8/i16/i32[numSelectors << contextBits][3], scratch
    // where [0]: confirmations, [1]: counts, [2]: predictions.
    //
    // unlike JS version, counts and predictions are spatially local to each other.
    // this however means that they should be using the same type for alignments.
    const M_CONTEXTS = 0x700;
    // inputs and outputs are variable, so we refer them with an offset to M_CONTEXTS.
    // the "pregap" before the input is required because contexts for first bytes are
    // padded with zeroes if they precede the first byte.
    //const M_PREGAP = M_CONTEXTS + ((numSelectors * 3) << (contextBits + contextItemShift));
    //const M_INPUT = M_PREGAP + 32;
    //const M_OUTPUT = M_INPUT + ceil(inputLen / 4) * 4;
    //const M_END = M_OUTPUT + inputLen * 4;

    let localCount = 0;

    // i32 arguments
    const INBITS = localCount++;
    const INPUTLEN = localCount++;
    const CONTEXTBITS = localCount++;
    const NUMSELECTORS = localCount++;
    const PRECISION = localCount++;
    const QUOTE = localCount++; // modelQuotes in the argument position (-1 or 0)
    const MODELMAXCOUNT = localCount++;
    const MARK = localCount++;
    const NI32ARGS = localCount;

    // f64 arguments
    const MODELBASECOUNT = localCount++;
    const RECIPLEARNINGRATE = localCount++;
    const NF64ARGS = localCount - NI32ARGS;

    // local i32 variables
    const NI32LOCALS = 11;
    const I32LOCALS = localCount;
    localCount += NI32LOCALS;
    let nextI32Local = 0;
    const withI32Locals = f => {
        const locals = [];
        for (let i = 0; i < f.length; ++i) locals.push(I32LOCALS + nextI32Local++);
        if (nextI32Local > NI32LOCALS) throw 'i32 local overflow';
        const ret = f(...locals);
        nextI32Local -= f.length;
        return ret;
    };

    // local i64 variables
    const NI64LOCALS = 1;
    const I64LOCALS = localCount;
    localCount += NI64LOCALS;
    let nextI64Local = 0;
    const withI64Locals = f => {
        const locals = [];
        for (let i = 0; i < f.length; ++i) locals.push(I64LOCALS + nextI64Local++);
        if (nextI64Local > NI64LOCALS) throw 'i64 local overflow';
        const ret = f(...locals);
        nextI64Local -= f.length;
        return ret;
    };

    // local f64 variables
    const NF64LOCALS = 2;
    const F64LOCALS = localCount;
    localCount += NF64LOCALS;
    let nextF64Local = 0;
    const withF64Locals = f => {
        const locals = [];
        for (let i = 0; i < f.length; ++i) locals.push(F64LOCALS + nextF64Local++);
        if (nextF64Local > NF64LOCALS) throw 'f64 local overflow';
        const ret = f(...locals);
        nextF64Local -= f.length;
        return ret;
    };

    const body = [
        // local variables
        vec(
            [~NI32LOCALS, I32],
            [~NI64LOCALS, I64],
            [~NF64LOCALS, F64],
        ),

        ...withI32Locals((INPUTOFF, OUTPUTOFF, QUOTESSEEN) => [
            // quotesSeen = 0; // implied
            // outputOff = 
            //   (inputOff = ((numSelectors * 3) << (contextBits + contextItemShift)) + 32) +
            //   ((inputLen + 3) & ~3);
            set(OUTPUTOFF,
                add(
                    tee(INPUTOFF,
                        add(
                            shl(
                                mul(get(NUMSELECTORS), 3),
                                add(get(CONTEXTBITS), contextItemShift)),
                            32)),
                    and(add(get(INPUTLEN), 3), ~3))),

            // M_WEIGHTS[0..63] = 0.0;
            // M_CONTEXTS[inputOff-32..inputOff-1] = 0; // pregap
            memory_fill(M_WEIGHTS, 0, 64 * 8),
            memory_fill(add(M_CONTEXTS, sub(get(INPUTOFF), 32)), 0, 32),

            // do {
            loop(

                ...withI32Locals((BYTE, BITIDX, SELIDX) => [
                    // byte = M_CONTEXTS[inputOff];
                    set(BYTE, load8_u(M_CONTEXTS, get(INPUTOFF))),

                    // selIdx = 0;
                    // do {
                    set(SELIDX, 0),
                    loop(

                        ...withI32Locals(CONTEXTHASH => withI64Locals(SELECTOR => [
                            // selector = M_SELECTORS[selIdx << 3];
                            // contextHash = 0;
                            set(SELECTOR, load64(M_SELECTORS, shl(get(SELIDX), 3))),
                            set(CONTEXTHASH, 0),

                            // if (selector > 0) {
                            //   do {
                            if_(i64_gt_u(get(SELECTOR), 0), loop(

                                // contextHash = (contextHash + M_CONTEXTS[inputOff - (selector & 15)]) * 997;
                                set(CONTEXTHASH,
                                    mul(
                                        add(get(CONTEXTHASH),
                                            load8_u(M_CONTEXTS,
                                                sub(get(INPUTOFF), and(i32_wrap_i64(get(SELECTOR)), 15)))),
                                        997)),

                                // if ((selector = selector >> 4) > 0) continue;
                                br_if(0, i64_gt_u(tee(SELECTOR, i64_shr_u(get(SELECTOR), 4)), 0)),

                            //   } while (false);
                            // }
                            )),

                            // M_CONTEXTPARTIALHASH[selIdx << 2] = contextHash;
                            store32(M_CONTEXTPARTIALHASH, shl(get(SELIDX), 2), get(CONTEXTHASH)),
                        ])),

                        // if (++selIdx < numSelectors) continue;
                        br_if(0, lt_u(tee(SELIDX, add(get(SELIDX), 1)), get(NUMSELECTORS))),

                    // } while (false);
                    ),

                    // bitIdx = inBits;
                    // do {
                    set(BITIDX, get(INBITS)),
                    loop(

                        ...withI32Locals((BITCONTEXT, BIT, QUANTSUMPROB) => [
                            ...withF64Locals(SUMPROB => [
                                // bitContext = (byte + (1 << inBits)) >> bitIdx;
                                // bit = (byte >> --bitIdx) & 1;
                                // sumProb = 0.0;
                                set(BITCONTEXT, shr_u(add(get(BYTE), shl(1, get(INBITS))), get(BITIDX))),
                                set(BIT, and(shr_u(get(BYTE), tee(BITIDX, sub(get(BITIDX), 1))), 1)),
                                set(SUMPROB, f64(0)),

                                // selIdx = 0;
                                // do {
                                set(SELIDX, 0),
                                loop(

                                    ...withI32Locals(CONTEXTHASH => [
                                        // M_CONTEXTHASH[selIdx << 2] = (
                                        //   contextHash =
                                        //     ((
                                        //       (M_CONTEXTPARTIALHASH[selIdx << 2] + bitContext + (quote ? 129 : 0)) & ((1 << contextBits) - 1) |
                                        //       (selIdx << contextBits)
                                        //     ) * 3) << contextItemShift
                                        // );
                                        store32(M_CONTEXTHASH, shl(get(SELIDX), 2),
                                            tee(CONTEXTHASH,
                                                shl(
                                                    mul(
                                                        or(
                                                            and(
                                                                add(
                                                                    add(
                                                                        load32(M_CONTEXTPARTIALHASH, shl(get(SELIDX), 2)),
                                                                        get(BITCONTEXT)),
                                                                    select(get(QUOTE), i32(129), i32(0))),
                                                                sub(shl(1, get(CONTEXTBITS)), 1)),
                                                            shl(get(SELIDX), get(CONTEXTBITS))),
                                                        3),
                                                    contextItemShift))),

                                        // if (M_CONTEXTS[contextHash] !== mark) {
                                        if_(
                                            ne(loadContextItem(M_CONTEXTS, get(CONTEXTHASH)), get(MARK)),

                                            // M_CONTEXTS[contextHash] = mark;
                                            // M_CONTEXTS[contextHash + (1 << contextItemShift)] = 0;
                                            // M_CONTEXTS[contextHash + (2 << contextItemShift)] = 1 << (precision - 1);
                                            storeContextItem(M_CONTEXTS, get(CONTEXTHASH), get(MARK)),
                                            storeContextItem(M_CONTEXTS, add(get(CONTEXTHASH), 1 << contextItemShift), 0),
                                            storeContextItem(M_CONTEXTS, add(get(CONTEXTHASH), 2 << contextItemShift),
                                                shl(1, sub(get(PRECISION), 1))),

                                        // }
                                        ),

                                        ...withF64Locals(PROB => [
                                            // prob = ((M_CONTEXTS[contextHash + (2 << contextItemShift)] << 1) + 1) as f64;
                                            set(PROB, 
                                                f64_convert_i32_u(
                                                    add(
                                                        shl(
                                                            loadContextItem(M_CONTEXTS,
                                                                add(get(CONTEXTHASH), 2 << contextItemShift)),
                                                            1),
                                                        1))),

                                            // M_PREDICTIONS[selIdx << 3] =
                                            //   (prob = log(prob / ((2 << precision) as f64 - prob)));
                                            fstore(M_PREDICTIONS, shl(get(SELIDX), 3),
                                                tee(PROB,
                                                    call(F_LOG,
                                                        fdiv(
                                                            get(PROB),
                                                            fsub(
                                                                f64_convert_i32_u(shl(2, get(PRECISION))),
                                                                get(PROB)))))),

                                            // sumProb = sumProb - M_WEIGHTS[selIdx << 3] * prob;
                                            set(SUMPROB,
                                                fsub(get(SUMPROB),
                                                    fmul(
                                                        fload(M_WEIGHTS, shl(get(SELIDX), 3)),
                                                        get(PROB)))),
                                        ]),
                                    ]),

                                    // if (++selIdx < numSelectors) continue;
                                    br_if(0, lt_u(tee(SELIDX, add(get(SELIDX), 1)), get(NUMSELECTORS))),

                                // } while (false);
                                ),

                                // M_CONTEXTS[outputOff] = (
                                //   quantSumProb = ((2 << precision) - 1) as f64 / (1 + exp(sumProb)) as i32 | 1
                                // ) >> 1;
                                store32(M_CONTEXTS, get(OUTPUTOFF),
                                    shr_u(
                                        tee(QUANTSUMPROB,
                                            or(
                                                i32_trunc_f64_u(
                                                    fdiv(
                                                        f64_convert_i32_u(sub(shl(2, get(PRECISION)), 1)),
                                                        fadd(f64(1), call(F_EXP, get(SUMPROB))))),
                                                1)),
                                        1)),

                                // outputOff = outputOff + 4;
                                set(OUTPUTOFF, add(get(OUTPUTOFF), 4)),
                            ]),

                            // selIdx = 0;
                            // do {
                            set(SELIDX, 0),
                            loop(

                                ...withI32Locals((CONTEXTHASH, COUNT) => [
                                    // M_CONTEXTS[
                                    //   contextHash = M_CONTEXTHASH[selIdx << 2] + (1 << contextItemShift)
                                    // ] = (
                                    //   count = M_CONTEXTS[contextHash] + (M_CONTEXTS[contextHash] < modelMaxCount)
                                    // );
                                    storeContextItem(M_CONTEXTS,
                                        tee(CONTEXTHASH,
                                            add(
                                                load32(M_CONTEXTHASH, shl(get(SELIDX), 2)),
                                                1 << contextItemShift)),
                                        tee(COUNT,
                                            add(
                                                loadContextItem(M_CONTEXTS, get(CONTEXTHASH)),
                                                lt_u(loadContextItem(M_CONTEXTS, get(CONTEXTHASH)), get(MODELMAXCOUNT))))),

                                    // M_CONTEXTS[
                                    //   contextHash = contextHash + (1 << contextItemShift)
                                    // ] = M_CONTEXTS[contextHash] + ((
                                    //   (((bit << precision) - M_CONTEXTS[contextHash]) << (29 - precision)) as f64 /
                                    //   (count as f64 + modelBaseCount)
                                    // ) as i32 >> (29 - precision));
                                    storeContextItem(M_CONTEXTS,
                                        tee(CONTEXTHASH, add(get(CONTEXTHASH), 1 << contextItemShift)),
                                        add(
                                            loadContextItem(M_CONTEXTS, get(CONTEXTHASH)),
                                            shr_s(
                                                i32_trunc_f64_s(
                                                    fdiv(
                                                        f64_convert_i32_s(
                                                            shl(
                                                                sub(
                                                                    shl(get(BIT), get(PRECISION)),
                                                                    loadContextItem(M_CONTEXTS, get(CONTEXTHASH))),
                                                                sub(29, get(PRECISION)))),
                                                        fadd(f64_convert_i32_u(get(COUNT)), get(MODELBASECOUNT)))),
                                                sub(29, get(PRECISION))))),

                                    // M_WEIGHTS[selIdx << 3] =
                                    //   M_WEIGHTS[selIdx << 3] +
                                    //   (M_PREDICTIONS[selIdx << 3] / recipLearningRate) *
                                    //     (((bit << (precision + 1)) - quantSumProb) as f64 / (2 << precision) as f64);
                                    fstore(M_WEIGHTS, shl(get(SELIDX), 3),
                                        fadd(
                                            fload(M_WEIGHTS, shl(get(SELIDX), 3)),
                                            fmul(
                                                fdiv(
                                                    fload(M_PREDICTIONS, shl(get(SELIDX), 3)),
                                                    get(RECIPLEARNINGRATE)),
                                                fdiv(
                                                    f64_convert_i32_s(
                                                        sub(
                                                            shl(get(BIT), add(get(PRECISION), 1)),
                                                            get(QUANTSUMPROB))),
                                                    f64_convert_i32_u(
                                                        shl(2, get(PRECISION))))))),
                                ]),

                                // if (++selIdx < numSelectors) continue;
                                br_if(0, lt_u(tee(SELIDX, add(get(SELIDX), 1)), get(NUMSELECTORS))),

                            // } while (false);
                            ),
                        ]),

                        // if (bitIdx > 0) continue;
                        br_if(0, lt_u(0, get(BITIDX))),

                    // } while (false);
                    ),

                    // if (quote !== -1) {
                    if_(add(get(QUOTE), 1),
                        // if (quote) {
                        //   quote = quote === byte ? 0 : quote;
                        // }
                        if_else(get(QUOTE),
                            set(QUOTE, select(eq(get(QUOTE), get(BYTE)), i32(0), get(QUOTE))),
                        )
                        // else if (mask = (byte === 34) | ((byte === 39) << 1) | ((byte === 96) << 2)) {
                        //   quote = byte;
                        //   quotesSeen |= mask;
                        // }
                        (
                            ...withI32Locals(MASK => [
                                if_(
                                    tee(MASK,
                                        or(
                                            eq(get(BYTE), 34),
                                            or(
                                                shl(eq(get(BYTE), 39), 1),
                                                shl(eq(get(BYTE), 96), 2)))),

                                    set(QUOTE, get(BYTE)),
                                    set(QUOTESSEEN, or(get(QUOTESSEEN), get(MASK))),
                                ),
                            ]),
                        ),
                    // }
                    ),

                ]),

                // ++inputOff;
                // if (0 < --inputLen) continue;
                set(INPUTOFF, add(get(INPUTOFF), 1)),
                br_if(0, lt_u(0, tee(INPUTLEN, sub(get(INPUTLEN), 1)))),

            // } while (false);
            ),

            get(QUOTESSEEN),
        ]),
    ];

    const data = [
        0x00, 0x61, 0x73, 0x6d, // magic
        0x01, 0x00, 0x00, 0x00, // version

        // type section
        0x01, [...vec(
            // type 0: [i32*NI32ARGS, f64*NF64ARGS] -> [i32] (run)
            [
                0x60,
                ...vec(
                    ...Array(NI32ARGS).fill(I32),
                    ...Array(NF64ARGS).fill(F64),
                ),
                 ...vec(I32),
            ],

            // type 1: [f64] -> [f64] (Math.log/exp)
            [0x60, ...vec(F64), ...vec(F64)],

            ...DEBUG ? [
                // type 2: [i32] -> [] (console.log)
                [0x60, ...vec(I32), ...vec()],
                // type 3: [f64] -> [] (console.log)
                [0x60, ...vec(F64), ...vec()],
            ] : [],
        )],

        // import section
        0x02, [...vec(
            // Math.log [f64] -> [f64]
            ['Math', 'log', 0x00, ~1],
            // Math.exp [f64] -> [f64]
            ['Math', 'exp', 0x00, ~1],

            ...DEBUG ? [
                // console.log [i32] -> []
                ['console', 'log', 0x00, ~2],
                // console.log [f64] -> []
                ['console', 'log', 0x00, ~3],
            ] : [],
        )],

        // function section
        0x03, [...vec(
            ~0, // run
        )],

        // memory section
        0x05, [...vec(
            // memory 0: main memory (min 0KB, growable)
            [0x00, ~0],
        )],

        // export section
        0x07, [...vec(
            // memory: memory 0
            ['memory', 0x02, ~0],
            // run: function run()
            ['run', 0x00, ~F_RUN],
        )],

        // code section
        0x0a, [...vec(
            [[].concat(...body, [END])], // run
        )],
    ];

    const resolve = data => {
        const bytes = [];
        const u32 = v => {
            while (v >= 0x80) {
                bytes.push(v & 0x7f | 0x80);
                v >>= 7;
            }
            bytes.push(v);
        };
        for (const x of data) {
            if (Array.isArray(x)) { // length-prefixed bytes
                const inner = resolve(x);
                u32(inner.length);
                bytes.push(...inner);
            } else if (typeof x === 'string') { // name
                const utf8 = unescape(encodeURIComponent(x));
                u32(utf8.length);
                bytes.push(...[...utf8].map(c => c.charCodeAt(0)));
            } else if (x < 0) { // u32
                u32(~x >>> 0);
            } else { // raw bytes
                if (x >= 256) throw 'bad data: ' + x;
                bytes.push(x);
            }
        }
        return bytes;
    };

    const wasm = new Uint8Array(resolve(data));
    const module = new WebAssembly.Module(wasm);
    const instance = new WebAssembly.Instance(module, { Math, console });
    const { 'memory': memory, 'run': run } = instance.exports;

    let mark = 0;
    const maxMark = [0x100, 0x10000, 0x100000000][contextItemShift];
    let M_CONTEXTS_END = M_CONTEXTS;
    return (input, { inBits, contextBits, sparseSelectors, precision, modelQuotes, modelMaxCount, modelRecipBaseCount, recipLearningRate }) => {
        const requiredContextItemShift = getContextItemShift({ precision, modelMaxCount });
        if (requiredContextItemShift > contextItemShift) throw 'contextItemShift overflow';

        const M_PREGAP = M_CONTEXTS + ((sparseSelectors.length * 3) << (contextBits + contextItemShift));
        const M_INPUT = M_PREGAP + 32;
        const M_OUTPUT = M_INPUT + ((input.length + 3) & ~3);
        const M_END = M_OUTPUT + input.length * inBits * 4;

        // grow the memory if needed
        const lastMemorySize = memory.buffer.byteLength;
        if (M_END > lastMemorySize) {
            memory['grow']((M_END - memory.buffer.byteLength + 65535) >> 16);
        }

        // clear the memory if needed (see DirectContextModel about the mark)
        if (++mark === maxMark) {
            mark = 1;
            new Uint8Array(memory.buffer).fill(0);
        } else {
            // the marking mechanism assumes that a specific region of M_CONTEXTS
            // can only be set in a controlled way, but this might not be true.
            // for example, assume the following memory after the first invocation:
            //
            // +---------+----------------------------+---------+
            // | globals |         M_CONTEXTS         | in&out  |
            // +---------+----------------------------+---------+
            //
            // if the second invocation needs a larger M_CONTEXTS, the memory
            // would end up with the following:
            //
            //                                        |<-dirty->|<-----zeroed---->|
            // +---------+----------------------------------------------+---------+
            // | globals |                  M_CONTEXTS                  | in&out  |
            // +---------+----------------------------------------------+---------+
            //
            // there is a small chance that the dirty region is accessed *and*
            // the value in the mark position coincides with the current mark.
            // this bug can be very hard to track because in most cases the zeroed
            // region would be much larger than the dirty region. we need to
            // calculate the dirty region and clear it in order to prevent this.
            const dirtyEnd = Math.min(lastMemorySize, M_PREGAP);
            if (M_CONTEXTS_END < dirtyEnd) {
                new Uint8Array(memory.buffer).fill(0, M_CONTEXTS_END, dirtyEnd);
            }
        }
        M_CONTEXTS_END = M_PREGAP;

        // fill in the required portion of memory
        const selectorView = new Uint32Array(memory.buffer, M_SELECTORS);
        for (let i = 0; i < sparseSelectors.length; ++i) {
            const sel = sparseSelectors[i];
            if (sel > 0x7fff) throw 'sparseSelectors overflow';
            let indicesLo = 0, indicesHi = 0;
            for (let j = 0; j < 15; ++j) {
                if (sel >> j & 1) {
                    // can also use BigUint64Array, but this is the only occurrence of BigInt
                    // throughout Roadroller so we'd just avoid using it for the compatibility
                    indicesHi = (indicesHi << 4) | (indicesLo >>> 28);
                    indicesLo = (indicesLo << 4) | (j + 1);
                }
            }
            selectorView[i * 2] = indicesLo;
            selectorView[i * 2 + 1] = indicesHi;
        }
        new Uint8Array(memory.buffer, M_INPUT).set(input);

        let quotesSeenBits = 0;
        if (input.length > 0) {
            quotesSeenBits = run(
                inBits,
                input.length,
                contextBits,
                sparseSelectors.length,
                precision,
                modelQuotes ? 0 : -1,
                modelMaxCount,
                mark,
                1 / modelRecipBaseCount,
                recipLearningRate);
        }

        const quotesSeen = new Set();
        if (quotesSeenBits & 1) quotesSeen.add(34);
        if (quotesSeenBits & 2) quotesSeen.add(39);
        if (quotesSeenBits & 4) quotesSeen.add(96);

        return {
            predictions: new Uint32Array(memory.buffer, M_OUTPUT, input.length * inBits),
            quotesSeen,
        };
    };
};

