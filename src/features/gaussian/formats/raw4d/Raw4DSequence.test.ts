import { describe, expect, it } from 'vitest';
import {
  buildRaw4DSequenceSegments,
  locateRaw4DSequenceFrame,
  matchRaw4DSequenceBoundary,
  raw4DSequenceFrameRangeFromName,
} from './Raw4DSequence';
import type { Raw4DHeader } from './Raw4DTypes';
import type { Raw4DSequenceExtractedSegment } from './Raw4DSequenceTypes';

function header(totalFrames: number, vertexCount = 3): Raw4DHeader {
  const propertyNames = [
    'xyz_bank_0_x', 'xyz_bank_0_y', 'xyz_bank_0_z',
    'xyz_bank_1_x', 'xyz_bank_1_y', 'xyz_bank_1_z',
    ...[0, 1].flatMap((bank) => ['w', 'x', 'y', 'z'].map((component) => `rot_bank_${bank}_${component}`)),
    'f_dc_bank_0_0', 'f_dc_bank_0_1', 'f_dc_bank_0_2',
    'f_dc_bank_1_0', 'f_dc_bank_1_1', 'f_dc_bank_1_2',
    ...[0, 1].flatMap((bank) => ['0', '1', '2'].map((component) => `scale_bank_${bank}_${component}`)),
    'opacity_bank_0', 'opacity_bank_1',
    ...Array.from({ length: 45 }, (_, index) => `f_rest_${index}`),
  ];
  return {
    dataOffset: 100,
    recordBytes: propertyNames.length * 2,
    vertexCount,
    totalFrames,
    scalarEncoding: 'float16',
    propertyNames,
    comments: new Map([
      ['total_frames', String(totalFrames)],
      ['xyz_bank_keyframe_stride', '30'],
      ['rot_bank_keyframe_stride', '30'],
      ['features_dc_bank_keyframe_stride', '30'],
      ['scaling_bank_keyframe_stride', '30'],
      ['opacity_bank_keyframe_stride', '30'],
    ]),
  };
}

function extracted(
  firstPositionBits: number[],
  lastPositionBits: number[],
  shBits: number[],
): Raw4DSequenceExtractedSegment {
  const count = firstPositionBits.length / 3;
  return {
    encoding: 'float16',
    count,
    shCoefficientCount: 2,
    firstPositionBits: Uint32Array.from(firstPositionBits),
    lastPositionBits: Uint32Array.from(lastPositionBits),
    firstColorDcBits: new Uint32Array(count * 3),
    lastColorDcBits: new Uint32Array(count * 3),
    shBits: Uint32Array.from(shBits),
  };
}

describe('RAW4D multi-part sequence', () => {
  it('sorts explicit frame ranges and removes duplicate boundary frames', () => {
    expect(raw4DSequenceFrameRangeFromName('segment_180_210.raw4d')).toEqual({ firstFrame: 180, lastFrame: 210 });
    const segments = buildRaw4DSequenceSegments([
      { fileIndex: 0, name: 'segment_210_240.raw4d', header: header(31, 4) },
      { fileIndex: 1, name: 'segment_180_210.raw4d', header: header(31, 3) },
      { fileIndex: 2, name: 'segment_240_259.raw4d', header: header(20, 5) },
    ]);
    expect(segments.map((segment) => segment.fileIndex)).toEqual([1, 0, 2]);
    expect(locateRaw4DSequenceFrame(segments, 29)).toMatchObject({ segmentIndex: 0, localFrame: 29, sourceFrame: 209 });
    expect(locateRaw4DSequenceFrame(segments, 30)).toMatchObject({ segmentIndex: 1, localFrame: 0, sourceFrame: 210 });
    expect(locateRaw4DSequenceFrame(segments, 79)).toMatchObject({ segmentIndex: 2, localFrame: 19, sourceFrame: 259 });
  });

  it('rejects gaps instead of silently joining unrelated clips', () => {
    expect(() => buildRaw4DSequenceSegments([
      { fileIndex: 0, name: 'segment_0_30.raw4d', header: header(31) },
      { fileIndex: 1, name: 'segment_31_61.raw4d', header: header(31) },
    ])).toThrow(/共享同一个首尾边界帧/);
  });

  it('uses SH to disambiguate duplicate positions and counts exact SH updates', () => {
    const previous = extracted(
      [1, 2, 3, 1, 2, 3, 4, 5, 6],
      [1, 2, 3, 1, 2, 3, 4, 5, 6],
      [10, 11, 20, 21, 30, 31],
    );
    const current = extracted(
      [1, 2, 3, 1, 2, 3, 4, 5, 6],
      [1, 2, 3, 1, 2, 3, 4, 5, 6],
      [20, 21, 10, 11, 30, 99],
    );
    const match = matchRaw4DSequenceBoundary(previous, Int32Array.from([100, 101, 102]), current, 103);
    expect([...match.currentTrackMap]).toEqual([101, 100, 102]);
    expect(match.matchedCount).toBe(3);
    expect(match.duplicateCandidateCount).toBe(1);
    expect(match.shUpdateCount).toBe(1);
    expect(match.nextTrackId).toBe(103);
  });
});
