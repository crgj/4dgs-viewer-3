import { RAW4D_FLOAT16_DECODE_TABLE } from './Raw4DFloat16';
import type { Raw4DScalarArray, Raw4DScalarEncoding, Raw4DTrack } from './Raw4DTypes';

export function readRaw4DScalar(
  values: Raw4DScalarArray,
  index: number,
  encoding: Raw4DScalarEncoding,
): number {
  return encoding === 'float16'
    ? RAW4D_FLOAT16_DECODE_TABLE[(values as Uint16Array)[index]]
    : (values as Float32Array)[index];
}

export function readRaw4DTrack(track: Raw4DTrack, valueIndex: number, pointIndex: number): number {
  return readRaw4DScalar(track.values[valueIndex], pointIndex, track.encoding);
}

export function decodeRaw4DArray(
  values: Raw4DScalarArray,
  encoding: Raw4DScalarEncoding,
): Float32Array {
  if (encoding === 'float32') return values as Float32Array;
  const source = values as Uint16Array;
  const result = new Float32Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    result[index] = RAW4D_FLOAT16_DECODE_TABLE[source[index]];
  }
  return result;
}

export function raw4DScalarBits(values: Raw4DScalarArray, index: number, encoding: Raw4DScalarEncoding): number {
  if (encoding === 'float16') return (values as Uint16Array)[index];
  return new Uint32Array(values.buffer, values.byteOffset, values.length)[index];
}
