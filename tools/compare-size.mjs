// this script reads the Roadroller'd code (which should have exactly two lines) 
// and runs various compression algorithms that return a DEFLATE stream.
// uses regpack and @gfx/zopfli if available.

import * as zlib from 'zlib';
import * as fs from 'fs';
import * as process from 'process';
let zopfli; try { zopfli = await import('@gfx/zopfli'); } catch (e) { /* do nothing */ }
let packer; try { packer = (await import('regpack')).packer; } catch (e) { /* do nothing */ }
import { analyzeDeflate } from '../deflate.mjs';

const data = fs.readFileSync(process.argv[2], 'utf-8').trim();
const sep = data.indexOf('\n') + 1;
if (sep <= 0) throw 'oops';

const buf = Uint8Array.from(data, c => c.charCodeAt(0));
const buf1 = Uint8Array.from(data.slice(0, sep), c => c.charCodeAt(0));
const buf2 = Uint8Array.from(data.slice(sep), c => c.charCodeAt(0));
const buf2regpack = packer && Uint8Array.from(doRegpack(data.slice(sep)), c => c.charCodeAt(0));

// since the first line is not compressible except for the 6-bit packing,
// we only need literal codes in the Huffman tree.
// zlib doesn't know this fact, so we explicitly set the strategy and flush the stream appropriately.
function twoPartDeflate(buf1, buf2, options) {
    return new Promise(resolve => {
        const deflate = zlib.createDeflate({ level: 1, strategy: zlib.constants.Z_HUFFMAN_ONLY });
        const buffers = [];
        deflate.on('data', buf => buffers.push(buf));
        deflate.on('end', buf => resolve(Buffer.concat(buffers)));
        deflate.write(buf1, () => {
            deflate.params(options.level, zlib.constants.Z_DEFAULT_STRATEGY); 
            deflate.flush(zlib.constants.Z_BLOCK);
            deflate.end(buf2);
        });
    });
}

function analyze(buf) {
    console.log([...analyzeDeflate('zlib', buf)].map(i => [i[0] / 8, i.slice(1).reduce((x,[y]) => x + y, 0) / 8]));
    return buf.length;
}

function doRegpack(input) {
    var inputList = packer.runPacker(input, {
        withMath: false,
        hash2DContext: true,
        hashWebGLContext: true,
        hashAudioContext: true,
        contextVariableName: "c",
        contextType: 0,
        reassignVars: true,
        varsNotReassigned: "_",
        crushGainFactor: 1,
        crushLengthFactor: 0,
        crushCopiesFactor: 0,
        crushTiebreakerFactor: 1,
        wrapInSetInterval: false,
        timeVariableName: "",
        useES6: true
    });
    var methodCount = inputList.length;

    var bestMethod=0, bestStage=0, bestCompression=1e8;
    for (var i=0; i<methodCount; ++i) {
        var packerData = inputList[i];
        //console.log(packerData);
        for (var j=0; j<4; ++j) {
            var output = (j==0 ? packerData.contents : packerData.result[j-1][1]);
            var packedLength = packer.getByteLength(output);
            //console.log(packedLength);
            if (packedLength > 0 && packedLength < bestCompression) {
                bestCompression = packedLength;
                bestMethod = i;
                bestStage = j;
            } 
        }
    } 
    const bestOutput = inputList[bestMethod];
    const bestVal = (bestStage==0 ? bestOutput.contents : bestOutput.result[bestStage-1][1]);
    return bestVal;
}

console.log('deflate with default flush', analyze(zlib.deflateSync(buf, { level: 9 })));
console.log('deflate with optimal flush', analyze(await twoPartDeflate(buf1, buf2, { level: 9 })));
if (buf2regpack) {
    console.log('deflate with optimal flush (regpack)', analyze(await twoPartDeflate(buf1, buf2regpack, { level: 9 })));
}
console.log('deflate separately', Math.ceil(buf1.length * 6 / 8) + analyze(zlib.deflateSync(buf2, { level: 9 })));
console.log('deflate separately (low)', Math.ceil(buf1.length * 6 / 8) + analyze(zlib.deflateSync(buf2, { level: 1 })));
if (buf2regpack) {
    console.log('deflate separately (low, regpack)', Math.ceil(buf1.length * 6 / 8) + analyze(zlib.deflateSync(buf2regpack, { level: 1 })));
    console.log('no deflate (regpack)', Math.ceil(buf1.length * 6 / 8) + buf2regpack.length);
}
if (zopfli) {
    console.log('zopfli 15', analyze(await zopfli.zlibAsync(buf, { numIterations: 15 })));
    console.log('zopfli 15 separately', Math.ceil(buf1.length * 6 / 8) + analyze(await zopfli.zlibAsync(buf2, { numIterations: 15 })));
    if (buf2regpack) {
        console.log('zopfli 15 separately (regpack)', Math.ceil(buf1.length * 6 / 8) + analyze(await zopfli.zlibAsync(buf2regpack, { numIterations: 15 })));
    }
}

