import { describe, expect, it } from 'vitest';
import type { FourCgsSegment } from './FourCgsTypes';
import {
  createFourCgsCanonicalRaw4D,
  expandFourCgsCanonicalRaw4DRows,
  fourCgsCanonicalRaw4DPropertyNames,
  fourCgsDecodedPropertyNames,
  fourCgsRaw4DKeyframeStrides,
} from './FourCgsRaw4D';

const segment: FourCgsSegment = {
  name: 'segment_0_10',
  firstFrame: 0,
  lastFrame: 10,
  gaussianCount: 2,
  totalFrames: 11,
  bankCounts: { position: 5, rotation: 3, colorDc: 3, scale: 3, opacity: 3 },
  keyframeStrides: { position: 3, rotation: 5, colorDc: 5, scale: 5, opacity: 5 },
};

describe('4CGS canonical RAW4D output', () => {
  it('reconstructs canonical base snapshots and zero normals from the compact decoder layout', () => {
    const decodedNames = fourCgsDecodedPropertyNames(segment);
    const decodedRows = new Uint16Array(segment.gaussianCount * decodedNames.length);
    for (let row = 0; row < segment.gaussianCount; row += 1) {
      for (let property = 0; property < decodedNames.length; property += 1) {
        decodedRows[row * decodedNames.length + property] = row * 1000 + property + 1;
      }
    }
    const canonical = expandFourCgsCanonicalRaw4DRows(segment, decodedNames, decodedRows);
    const canonicalIndex = new Map(canonical.names.map((name, index) => [name, index]));
    const decodedIndex = new Map(decodedNames.map((name, index) => [name, index]));
    const at = (row: number, name: string) => canonical.rows[row * canonical.names.length + canonicalIndex.get(name)!];
    const sourceAt = (row: number, name: string) => decodedRows[row * decodedNames.length + decodedIndex.get(name)!];

    expect(canonical.names).toEqual(fourCgsCanonicalRaw4DPropertyNames(segment));
    expect(at(1, 'x')).toBe(sourceAt(1, 'xyz_bank_0_x'));
    expect(at(1, 'f_dc_2')).toBe(sourceAt(1, 'f_dc_bank_0_2'));
    expect(at(1, 'scale_1')).toBe(sourceAt(1, 'scale_bank_0_1'));
    expect(at(1, 'opacity')).toBe(sourceAt(1, 'opacity_bank_0'));
    expect([at(1, 'nx'), at(1, 'ny'), at(1, 'nz')]).toEqual([0, 0, 0]);
  });

  it('writes all six source timing comments and keeps the irregular final keyframe semantics', () => {
    expect(fourCgsRaw4DKeyframeStrides(segment)).toEqual(segment.keyframeStrides);
    const names = fourCgsDecodedPropertyNames(segment);
    const output = createFourCgsCanonicalRaw4D(segment, names, new Uint16Array(segment.gaussianCount * names.length));
    const fullText = new TextDecoder().decode(output.subarray(0, Math.min(output.length, 32_000)));
    expect(fullText).toContain('format binary_little_endian 1.0');
    expect(fullText).toContain('comment xyz_bank_keyframe_stride 3');
    expect(fullText).toContain('comment scaling_bank_keyframe_stride 5');
    expect(fullText).toContain('property ushort x');
    expect(fullText.indexOf('property ushort x')).toBeLessThan(fullText.indexOf('property ushort xyz_bank_0_x'));
  });
});
