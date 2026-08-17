export interface Raw4DSource {
  readonly size: number;
  slice(start?: number, end?: number): Blob;
}

// #WDD-gpt  2026-08-15 - 新版 RAW4D 用 ushort 承载 IEEE 754 binary16 位模式。
export type Raw4DScalarEncoding = 'float32' | 'float16';

// #WDD-gpt 2026-08-16 - Canonical RAW4D 保留源标量位宽；FP16 不再为驻留内存提前膨胀成 Float32Array。
export type Raw4DScalarArray = Float32Array | Uint16Array;

export interface Raw4DTrack {
  readonly encoding: Raw4DScalarEncoding;
  readonly components: number;
  readonly keyframes: readonly number[];
  readonly values: readonly Raw4DScalarArray[];
}

export interface Raw4DBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface Raw4DAsset {
  readonly sourceName: string;
  readonly sourceEncoding: Raw4DScalarEncoding;
  readonly splatCount: number;
  readonly totalFrames: number;
  readonly shBands: number;
  readonly position: Raw4DTrack;
  readonly rotation: Raw4DTrack;
  readonly colorDc: Raw4DTrack;
  readonly scale: Raw4DTrack;
  readonly opacity: Raw4DTrack;
  readonly shRest: readonly Raw4DScalarArray[];
  readonly lifetimeMu: Raw4DScalarArray;
  readonly lifetimeW: Raw4DScalarArray;
  readonly bounds: Raw4DBounds;
}

// #WDD-gpt 2026-08-16 - 4CGS 保存冻结 Canonical RAM 与删除位集，不再回读最初拖入的 File 作为属性真值。
export interface Raw4DMemorySnapshot {
  readonly name: string;
  readonly asset: Raw4DAsset;
  readonly deletionWords: Uint32Array;
}

export interface Raw4DParseProgress {
  readonly ratio: number;
  readonly stage: 'header' | 'data' | 'finalizing';
  readonly message: string;
}

export interface Raw4DChunkExtraction {
  readonly chunk: Float32Array | Uint16Array;
  readonly sourceEncoding: Raw4DScalarEncoding;
  readonly propertyCount: number;
  readonly firstRow: number;
  readonly rowCount: number;
  readonly properties: readonly {
    readonly sourceIndex: number;
    readonly destination: Raw4DScalarArray;
  }[];
}

export interface Raw4DParseOptions {
  readonly sourceName?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Raw4DParseProgress) => void;
  readonly chunkRows?: number;
  readonly createStorage?: (length: number, encoding: Raw4DScalarEncoding) => Raw4DScalarArray;
  readonly extractChunk?: (extraction: Raw4DChunkExtraction) => void | Promise<void>;
}

export interface Raw4DHeader {
  readonly dataOffset: number;
  readonly recordBytes: number;
  readonly vertexCount: number;
  readonly totalFrames: number;
  readonly scalarEncoding: Raw4DScalarEncoding;
  readonly propertyNames: readonly string[];
  readonly comments: ReadonlyMap<string, string>;
}
