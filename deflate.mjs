// Roadroller: Flattens your JS demo
// Copyright (c) 2021 Kang Seonghoon. See LICENSE.txt for details.

// simulates a single and final DEFLATE block and returns its length in bytes.
// this should be roughly in agreement with zlib -5 minus zlib header (6 bytes).
// adapted from https://github.com/nothings/stb/blob/master/stb_image_write.h
//
// we need zlib or equivalent to evaluate different selectors, but browsers do not have zlib.
// instead of building upon the existing library (pako etc.), we... just emulate zlib by ourselves,
// so that we can fit every dependency into a single compressed file in the online demo.
export const estimateDeflatedSize = s => {
    if (s.length > 2583 || s.match(/[^\0-\xff]/)) {
        throw new Error('estimateDeflatedSize: too long or non-Latin1 input');
    }

    // we don't really output the correct DEFLATE stream,
    // so as long as we can calculate correct frequencies we can reorder symbols in any order.
    const symbols = [256];
    const distances = [];
    let extraBits = 0;

    const pastMatches = {};
    const matchLen = (i, j) => {
        let len;
        for (len = 0; len < 258 && s[i + len] === s[j + len]; ++len);
        return len;
    };
    const MIN_MATCH = 3;
    next: for (let i = 0; i < s.length - MIN_MATCH; ) {
        let bestLen = MIN_MATCH;
        let bestOff = -1;

        const matches = pastMatches[s.substr(i, MIN_MATCH)] || [];
        pastMatches[s.substr(i, MIN_MATCH)] = matches;
        for (const off of matches) {
            // due to the limited input size we can never go past the match window
            const len = matchLen(i, off);
            if (bestLen < len) {
                bestLen = len;
                bestOff = off;
            }
        }
        matches.push(i);
        if (bestOff < 0) {
            // no match at all: emit a literal symbol
            symbols.push(s.charCodeAt(i++));
            continue;
        }

        // lazy match: if we delay the start of match a bit and
        // get a better match then ignore the current match
        for (const off of pastMatches[s.substr(i + 1, 3)] || []) {
            if (bestLen < matchLen(i + 1, off)) {
                symbols.push(s.charCodeAt(i++));
                continue next;
            }
        }

        // match: emit a length symbol and a distance symbol
        let len = bestLen - 3;
        let dist = i - bestOff - 1;
        let lenCode, distCode;
        for (lenCode = 0; lenCode < 28; ++lenCode) {
            // length extra bits: 0 x8, 1 x4, 2 x4, 3 x4, 4 x4, 5 x4, 0
            // the final 0 is not reached in this loop
            const lenExtraBits = Math.max(0, (lenCode - 4) >> 2);
            len -= 1 << lenExtraBits;
            if (len < 0) break;
        }
        for (distCode = 0; distCode < 29; ++distCode) {
            // distance extra bits: 0 x4, 1 x2, 2 x2, ..., 12 x2, 13 x2
            const distExtraBits = Math.max(0, (distCode - 2) >> 1);
            dist -= 1 << distExtraBits;
            if (dist < 0) break;
        }
        symbols.push(257 + lenCode);
        distances.push(distCode);
        extraBits +=
            (lenCode < 28 ? Math.max(0, (lenCode - 4) >> 2) : 0) +
            Math.max(0, (distCode - 2) >> 1);
        i += bestLen;
    }

    // constructs the canonical Huffman tree for given codes
    // and returns [# of bits used for codewords, an array of codeword lengths]
    const buildHuffman = codes => {
        const freqs = new Map();
        for (const code of codes) freqs.set(code, (freqs.get(code) || 0) + 1);

        let forest = [...freqs.entries()];
        while (forest.length > 1) {
            forest.sort(([a,na], [b,nb]) => nb - na || (a < b ? -1 : a > b ? 1 : 0));
            const [a, na] = forest.pop();
            const [b, nb] = forest.pop();
            forest.push([[a, b], na + nb]);
        }

        let lengths = [], bits = 0;
        const recur = (tree, len) => {
            // it is possible (but very unlikely) that len exceeds the DEFLATE limit of 15.
            // there is a dedicated algorithm for length-limited Huffman codes, but we are lazy;
            // since the maximum code length of k requires at least fib(k) input symbols
            // (where fib(0) = 1, fib(1) = 2, fib(2) = 3, fib(3) = 5 etc.),
            // we can simply limit ourselves by less than fib(16) = 2584 input symbols.
            if (tree.length) {
                recur(tree[0], len + 1);
                recur(tree[1], len + 1);
            } else {
                lengths[tree] = len;
                bits += len * freqs.get(tree);
            }
        };
        recur(forest[0][0], 0);
        return [bits, lengths];
    };

    const [symbolBits, symbolLengths] = buildHuffman(symbols);
    const [distBits, distLengths] = buildHuffman(distances);

    // canonical Huffman tree is encoded in another Huffman code;
    const treeCodes = [];
    let treeExtraBits = 0;
    let lastLen = -1;
    let lastRun = 0;
    for (let len of [...symbolLengths, ...distLengths, -1]) { // -1 ensures that the last run is flushed
        len |= 0;
        if (len === lastLen) {
            ++lastRun;
        } else {
            // emit the longest possible "repeat" code until we can't.
            // since we can directly emit a run of 0s but not a run of non-zero codes
            // (we can only emit an explicit code plus a repeat code),
            // we have a different threshold for zero length and non-zero lengths.
            while (lastRun >= (lastLen > 0 ? 4 : 3)) {
                const [code, codeExtraBits, maxRun] =
                    lastLen > 0 ? [16, 2, 7] :
                    lastRun < 11 ? [17, 3, 10] :
                    [18, 7, 138];
                if (lastLen > 0) treeCodes.push(lastLen);
                treeCodes.push(code);
                treeExtraBits += codeExtraBits;
                lastRun -= maxRun;
            }
            while (lastRun-- > 0) {
                treeCodes.push(lastLen);
            }
            lastLen = len;
            lastRun = 1;
        }
    }
    const [treeBits] = buildHuffman(treeCodes);

    // try all three supported block types and pick the smallest
    const dynamicHuffmanBits =
        17 + // BFINAL, BTYPE, HLIT, HDIST, HCLEN
        3 * Math.max(...treeCodes.map(code => {
            return [4, 18, 16, 14, 12, 10, 8, 6, 5, 7, 9, 11, 13, 15, 17, 19, 1, 2, 3][code];
        })) + // tree code lengths
        treeBits +
        treeExtraBits +
        symbolBits +
        distBits +
        extraBits;
    const fixedHuffmanBits =
        3 + // BFINAL, BTYPE
        symbols.reduce((acc, code) => {
            return acc + (code < 144 ? 8 : code < 256 ? 9 : code < 280 ? 7 : 8);
        }, 0) +
        5 * distances.length +
        extraBits;
    const uncompressedBits = 40 + 8 * s.length;

    const bestBits = Math.min(dynamicHuffmanBits, fixedHuffmanBits, uncompressedBits);
    return (bestBits + 7) >> 3;
};

// assumes the zopfli output; error handling is sparse
// format is either 'gzip', 'zlib' or 'deflate'
// output is [[DEFLATE overhead, [bit size, inflated buf], ...], ...]
// e.g. [[25, [9, [65]], [7, [66, 67, 68]]]] corresponds to a stream
//      where `A` encoded in 9 bits, `BCD` together encoded in 7 bits,
//      and all wrapped with 25 bit overhead from DEFLATE (not counting containers)
export function* analyzeDeflate(format, deflated) {
    let cur = 0;
    let end = deflated.length;

    if (format === 'gzip') {
        if (deflated[0] !== 0x1f) throw 'gzip with incorrect magic1';
        if (deflated[1] !== 0x8b) throw 'gzip with incorrect magic2';
        if (deflated[2] !== 0x08) throw 'gzip with unexpected compression method';
        const flags = deflated[3];
        cur = 10;
        if (flags & 0x04) cur += 2 + (deflated[cur] | deflated[cur + 1] << 8) + 2; // FEXTRA
        if (flags & 0x08) cur = deflated.indexOf(0, cur) + 1; // FNAME
        if (flags & 0x10) cur = deflated.indexOf(0, cur) + 1; // FCOMMENT
        if (flags & 0x02) cur += 2; // FHCRC
        end -= 8;
    } else if (format === 'zlib') {
        if ((deflated[0] & 0x0f) !== 0x08) throw 'zlib with unexpected compression method';
        if (deflated[1] & 0x20) throw 'zlib with unexpected preset dictionary';
        if (((deflated[0] << 8 | deflated[1]) >>> 0) % 31) throw 'zlib with incorrect check'; 
        cur = 2;
        end -= 4;
    }

    let unread = 0;
    let nunread = 0; // bits
    const nbitsRead = () => cur * 8 + nunread;
    const bits = (nbits=1) => {
        while (nunread < nbits) {
            if (cur >= end) throw 'incomplete deflate stream';
            unread |= deflated[cur++] << nunread;
            nunread += 8;
        }
        const read = unread & ((1 << nbits) - 1);
        unread >>= nbits;
        nunread -= nbits;
        return read;
    };
    const bytes = (nbytes=1) => {
        if (cur + nbytes >= end) throw 'incomplete deflate stream';
        unread = nunread = 0; // sync to byte boundary
        const start = cur;
        cur += nbytes;
        return deflated.slice(start, cur);
    };

    const lzWindow = [];
    while (true) {
        const blockStart = nbitsRead();
        const blockIsFinal = bits();
        const blockType = bits(2);
        if (blockType == 0) {
            const [len1, len2] = bytes(4);
            const len = len1 | len2 << 8;
            const overhead = nbitsRead() - blockStart;
            const read = bytes(len);
            lzWindow.push(...read);
            yield [overhead, [len * 8, read]];
        } else if (blockType === 3) {
            throw 'deflate with reserved block type';
        } else {
            const treeFromLengths = lengths => {
                const tree = {};
                let code = 0;
                for (let i = 1; i < lengths.length; ++i) {
                    lengths.forEach((length, symbol) => {
                        if (length === i) tree[[i, code++]] = symbol;
                    });
                    code <<= 1;
                }
                tree.maxLength = lengths.length - 1;
                return tree;
            };

            const decodeFromTree = tree => {
                let read = 0;
                let nread = 0;
                do {
                    read = read << 1 | bits();
                    ++nread;
                    const symbol = tree[[nread, read]];
                    if (symbol !== undefined) return [nread, symbol];
                } while (nread <= tree.maxLength);
                throw 'invalid huffman code in deflate stream';
            };

            let litOrLenTree, distTree;
            if (blockType === 1) {
                let i = 0, j;
                litOrLenTree = { maxLength: 9 };
                for (j = 0b00110000; i < 144; ) litOrLenTree[[8, j++]] = i++;
                for (j = 0b110010000; i < 256; ) litOrLenTree[[9, j++]] = i++;
                for (j = 0b0000000; i < 280; ) litOrLenTree[[7, j++]] = i++;
                for (j = 0b11000000; i < 288; ) litOrLenTree[[8, j++]] = i++;
                distTree = { maxLength: 5 };
                for (i = j = 0; i < 32; ) distTree[[5, j++]] = i++;
            } else {
                const ncodes = bits(5) + 257; // # of (non-literal) length codes
                const ndists = bits(5) + 1; // # of distance codes

                // intermediate tree
                const nicodes = bits(4) + 4;
                const icodes = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15].slice(0, nicodes);
                const icodeLengths = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                for (const icode of icodes) icodeLengths[icode] = bits(3);
                const icodeTree = treeFromLengths(icodeLengths);

                // actual huffman trees (two of them, but decoded into a single stream before split)
                const codeLengths = [];
                while (codeLengths.length < ncodes + ndists) {
                    const [_, c] = decodeFromTree(icodeTree);
                    if (c === 16) {
                        const last = codeLengths[codeLengths.length - 1];
                        for (let i = bits(2) + 3; i > 0; --i) codeLengths.push(last);
                    } else if (c === 17) {
                        for (let i = bits(3) + 3; i > 0; --i) codeLengths.push(0);
                    } else if (c === 18) {
                        for (let i = bits(7) + 11; i > 0; --i) codeLengths.push(0);
                    } else {
                        codeLengths.push(c);
                    }
                }
                litOrLenTree = treeFromLengths(codeLengths.slice(0, ncodes));
                distTree = treeFromLengths(codeLengths.slice(ncodes));
            }

            const lenBase = [
                3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
                35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
            ];
            const lenBits = [
                0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
                4, 4, 4, 4, 5, 5, 5, 5, 0,
            ];
            const distBase = [
                1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129,
                193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
                6145, 8193, 12289, 16385, 24577,
            ];
            const distBits = [
                0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7,
                8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
            ];

            const block = [nbitsRead() - blockStart];
            while (true) {
                let [nread, c] = decodeFromTree(litOrLenTree);
                if (c < 256) {
                    block.push([nread, [c]]);
                    lzWindow.push(c);
                } else if (c === 256) {
                    block[0] += nread; // end-of-block symbol is kinda overhead
                    break;
                } else {
                    c -= 257;
                    nread += lenBits[c];
                    const length = bits(lenBits[c]) + lenBase[c];
                    [, c] = decodeFromTree(distTree);
                    nread += distBits[c];
                    const distance = bits(distBits[c]) + distBase[c];
                    for (let i = 0; i < length; ++i) {
                        lzWindow.push(lzWindow[lzWindow.length - distance]);
                    }
                    block.push([nread, lzWindow.slice(-length)]);
                }
            }
            yield block;
        }
        if (blockIsFinal) break;
    }
}

