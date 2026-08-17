import type { FourCgsManifest } from './FourCgsTypes';

export const RAW4D_BUNDLE_CODEC_NAME = 'CoRe4D-Browser-Raw4D-Lossless-DeflateShuffle16-V1';
export const RAW4D_BUNDLE_CHUNK_BYTES = 16 * 1024 * 1024;

export interface FourCgsRaw4DBundleMetadata {
  readonly version: 1;
  readonly chunkBytes: number;
  readonly segmentChunkCounts: readonly number[];
  readonly sourceNames: readonly string[];
  readonly sourceByteLengths: readonly number[];
  readonly sourceSha256: readonly string[];
  readonly exactSourceBytes: true;
  readonly originalPointCount?: number;
  readonly encodedPointCount?: number;
  readonly deletedPointCount?: number;
}

export function raw4DBundleStreamName(segmentIndex: number, chunkIndex: number): string {
  return `raw4d_segment:${segmentIndex}:${chunkIndex}`;
}

export function raw4DBundleMetadata(manifest: FourCgsManifest): FourCgsRaw4DBundleMetadata | null {
  if (manifest.codecName !== RAW4D_BUNDLE_CODEC_NAME) return null;
  const value = manifest.metadata?.raw4dBundle;
  return value && typeof value === 'object' ? value as FourCgsRaw4DBundleMetadata : null;
}

export function paddedEvenLength(byteLength: number): number {
  return byteLength + (byteLength & 1);
}

// #WDD-gpt 2026-08-16 - RAW4D FP16 先按低/高字节平面重排再压缩；奇数字节文件只在容器流尾补零，清单保留原始长度。
export function shuffle16WithPadding(source: Uint8Array): Uint8Array {
  const paddedLength = paddedEvenLength(source.byteLength);
  const values = paddedLength / 2;
  const shuffled = new Uint8Array(paddedLength);
  for (let index = 0; index < values; index += 1) {
    const sourceOffset = index * 2;
    shuffled[index] = source[sourceOffset] ?? 0;
    shuffled[values + index] = source[sourceOffset + 1] ?? 0;
  }
  return shuffled;
}

export function unshuffle16(source: Uint8Array): Uint8Array {
  if (source.byteLength % 2 !== 0) throw new Error('4CGS FP16 shuffle 长度必须为偶数。');
  const values = source.byteLength / 2;
  const output = new Uint8Array(source.byteLength);
  for (let index = 0; index < values; index += 1) {
    output[index * 2] = source[index];
    output[index * 2 + 1] = source[values + index];
  }
  return output;
}

export function raw4DBundleOutputName(sourceNames: readonly string[], firstFrame: number, lastFrame: number): string {
  if (sourceNames.length === 1) return `${sourceNames[0].replace(/\.(?:raw4d|ply4)$/i, '')}.4cgs`;
  return `raw4d_sequence_${firstFrame}_${lastFrame}.4cgs`;
}
