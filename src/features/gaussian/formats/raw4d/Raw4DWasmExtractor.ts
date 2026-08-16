import type { Raw4DChunkExtraction } from './Raw4DTypes';
import { RAW4D_FLOAT16_DECODE_TABLE } from './Raw4DFloat16';

const DEINTERLEAVER_BASE64 = 'AGFzbQEAAAABCgFgBn9/f39/fwADAgEABQMBAAEHHQIGbWVtb3J5AgAQZGVpbnRlcmxlYXZlX2YzMgAACmkBZwEEfwJAA0AgBiACTw0BQQAhBwJAA0AgByAFTw0BIAYgA2wgBCAHQQRsaigCAGohCCAHIAJsIAZqIQkgASAJQQRsaiAAIAhBBGxqKgIAOAIAIAdBAWohBwwACwsgBkEBaiEGDAALCws=';

interface ExtractorExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly deinterleave_f32: (
    sourceOffset: number,
    destinationOffset: number,
    rows: number,
    stride: number,
    indicesOffset: number,
    propertyCount: number,
  ) => void;
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function decodeModule(): ArrayBuffer {
  const binary = atob(DEINTERLEAVER_BASE64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export class Raw4DWasmExtractor {
  private constructor(private readonly exports: ExtractorExports) {}

  static async create(): Promise<Raw4DWasmExtractor> {
    const module = await WebAssembly.compile(decodeModule());
    const instance = await WebAssembly.instantiate(module);
    return new Raw4DWasmExtractor(instance.exports as ExtractorExports);
  }

  extract = (extraction: Raw4DChunkExtraction): void => {
    if (extraction.sourceEncoding === 'float16') {
      this.extractFloat16(extraction);
      return;
    }

    const sourceBytes = extraction.chunk.byteLength;
    const indicesOffset = align4(sourceBytes);
    const indicesBytes = extraction.properties.length * Uint32Array.BYTES_PER_ELEMENT;
    const destinationOffset = align4(indicesOffset + indicesBytes);
    const destinationElements = extraction.properties.length * extraction.rowCount;
    const requiredBytes = destinationOffset + destinationElements * Float32Array.BYTES_PER_ELEMENT;
    this.ensureCapacity(requiredBytes);

    const memory = this.exports.memory.buffer;
    new Uint8Array(memory, 0, sourceBytes).set(
      new Uint8Array(extraction.chunk.buffer, extraction.chunk.byteOffset, sourceBytes),
    );
    const indices = new Uint32Array(memory, indicesOffset, extraction.properties.length);
    for (let index = 0; index < extraction.properties.length; index += 1) {
      indices[index] = extraction.properties[index].sourceIndex;
    }

    // #WDD-gpt 2026-08-15 - AoS PLY 到 SoA TypedArray 的热点循环由 Worker 内 WASM 一次完成。
    this.exports.deinterleave_f32(
      0,
      destinationOffset,
      extraction.rowCount,
      extraction.propertyCount,
      indicesOffset,
      extraction.properties.length,
    );
    const output = new Float32Array(memory, destinationOffset, destinationElements);
    for (let property = 0; property < extraction.properties.length; property += 1) {
      const first = property * extraction.rowCount;
      (extraction.properties[property].destination as Float32Array).set(
        output.subarray(first, first + extraction.rowCount),
        extraction.firstRow,
      );
    }
  };

  private extractFloat16(extraction: Raw4DChunkExtraction): void {
    const source = extraction.chunk as Uint16Array;
    // #WDD-gpt 2026-08-16 - FP16 Canonical 路径直接反交错 ushort 位模式；兼容调用方仍可显式请求 Float32 目标。
    for (const property of extraction.properties) {
      let sourceOffset = property.sourceIndex;
      for (let row = 0; row < extraction.rowCount; row += 1) {
        if (property.destination instanceof Uint16Array) {
          property.destination[extraction.firstRow + row] = source[sourceOffset];
        } else {
          property.destination[extraction.firstRow + row] = RAW4D_FLOAT16_DECODE_TABLE[source[sourceOffset]];
        }
        sourceOffset += extraction.propertyCount;
      }
    }
  }

  private ensureCapacity(byteLength: number): void {
    const missing = byteLength - this.exports.memory.buffer.byteLength;
    if (missing > 0) this.exports.memory.grow(Math.ceil(missing / 65_536));
  }
}
