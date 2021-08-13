export class ArrayBufferPool {
    constructor();
    allocate(parent: object, size: number): ArrayBuffer;
    newUint32Array(parent: object, length: number): Uint32Array;
    newUint8Array(parent: object, length: number): Uint8Array;
    release(buf: ArrayBuffer): void;
}

export type ScaledFreq = number;

export type Bit = 0 | 1;

export interface AnsOptions {
    outBits: number;
    precision: number;
}

export interface AnsOutput {
    state: number;
    buf: number[];
}

export class AnsEncoder {
    constructor(options: AnsOptions);
    writeBit(bit: Bit, predictedFreq: ScaledFreq): void;
    finish(): AnsOutput;
}

export class AnsDecoder {
    constructor(output: AnsOutput, options: AnsOptions);
    readBit(predictedFreq: ScaledFreq): Bit;
}

export interface Model {
    predict(context?: number): ScaledFreq;
    update(actualBit: Bit, context?: number): void;
    release?(): void;
}

export interface BytewiseModel extends Model {
    updateByte(currentByte: number): void;
}

export function BytewiseModelMixin<Base extends new (...args: unknown[]) => Model>(base: Base):
    new (inBits: number, ...args: ConstructorParameters<Base>) => Base & BytewiseModel;

export interface DirectContextModelOptions {
    inBits: number;
    contextBits: number;
    precision: number;
    modelMaxCount: number;
    arrayBufferPool?: ArrayBufferPool;
}

export class DirectContextModel implements Model {
    constructor(options: DirectContextModelOptions);
    predict(context?: number): ScaledFreq;
    update(actualBit: Bit, context?: number): void;
    release(): void;
}

export interface SparseContextModelOptions extends DirectContextModelOptions {
    sparseSelector: number;
}

export class SparseContextModel implements BytewiseModel {
    constructor(options: SparseContextModelOptions);
    predict(context?: number): ScaledFreq;
    update(actualBit: Bit, context?: number): void;
    updateByte(currentByte: number): void;
    release(): void;
}

export interface LogisticMixModelOptions {
    learningRateNum: number;
    learningRateDenom: number;
    precision: number;
}

export class LogisticMixModel implements Model {
    constructor(models: Model[], options: LogisticMixModelOptions);
    predict(context?: number): ScaledFreq;
    update(actualBit: Bit, context?: number): void;
    release(): void;
}

export interface DefaultModelOptions extends DirectContextModelOptions, LogisticMixModelOptions {
    sparseSelectors: number[];
    modelQuotes: boolean;
}

export class DefaultModel implements BytewiseModel {
    constructor(options: DefaultModelOptions);
    predict(context?: number): ScaledFreq;
    update(actualBit: Bit, context?: number): void;
    updateByte(currentByte: number): void;
    release(): void;

    readonly quitesSeen: Set<number>;
}

export interface CompressOptions extends AnsOptions {
    inBits: number;
    calculateByteEntropy?: boolean;
}

export interface Output {
    inputLength: number;
    state: number;
    buf: number[];
}

export interface OutputExtra extends Output {
    bufLengthInBytes: number;
    byteEntropy?: number[];
}

export function compressWithModel(input: ArrayLike<number>, model: Model, options: CompressOptions): OutputExtra;
export function decompressWithModel(output: Output, model: Model, options: CompressOptions): number[];

export interface OptimizerProgressInfo {
    temperature: number;
    current: number[];
    currentSize: number;
    currentRejected: boolean;
    best: number[];
    bestSize: number[];
    bestUpdated: boolean;
}

export interface OptimizerResult {
    elapsedMsecs: number;
    best: number[];
    bestSize: number[];
}

export function defaultSparseSelectors(): number[];
export function optimizeSparseSelectors(
    selectors: number[],
    calculateSize: (selectors: number[]) => number,
    progress?: (info: OptimizerProgressInfo) => undefined | boolean | Promise<undefined | boolean>,
): Promise<OptimizerResult>;

export const enum InputType {
    JS = 'js',
    GLSL = 'glsl',
    HTML = 'html',
    Text = 'text',
    Binary = 'binary',
}

export const enum InputAction {
    Eval = 'eval',
    JSON = 'json',
    String = 'string',
    Write = 'write',
    Array = 'array',
    Uint8Array = 'u8array',
    Base64 = 'base64',
}

export interface Input {
    data: string | ArrayLike<number>;
    type: InputType;
    action: InputAction;
}

export interface PackerOptions {
    sparseSelectors?: number[];
    maxMemoryMB?: number;
    precision?: number;
    modelMaxCount?: number;
    arrayBufferPool?: ArrayBufferPool;
    learningRateNum?: number;
    learningRateDenom?: number;
}

export class Packer {
    constructor(inputs: Input[], options: PackerOptions);
    makeDecoder(): {
        firstLine: string;
        firstLineLengthInBytes: number;
        secondLine: string;
    };
    optimizeSparseSelectors(
        progress?: (info: OptimizerProgressInfo) => undefined | boolean | Promise<undefined | boolean>,
    ): Promise<OptimizerResult>;
}

