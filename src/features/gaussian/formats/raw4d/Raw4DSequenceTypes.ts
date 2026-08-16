import type { Raw4DScalarEncoding } from './Raw4DTypes';

export interface Raw4DSequenceSegment {
  readonly fileIndex: number;
  readonly name: string;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly totalFrames: number;
  readonly splatCount: number;
  readonly shBands: number;
  readonly shCoefficientCount: number;
  readonly keyframes: {
    readonly position: readonly number[];
    readonly rotation: readonly number[];
    readonly colorDc: readonly number[];
    readonly scale: readonly number[];
    readonly opacity: readonly number[];
  };
}

export interface Raw4DSequenceBoundaryMatch {
  readonly previous: string;
  readonly current: string;
  readonly matchedCount: number;
  readonly matchedRatio: number;
  readonly duplicateCandidateCount: number;
  readonly shUpdateCount: number;
  readonly method: 'exact_scalar_bits_position_sh_dc_tie_break';
}

export interface Raw4DSequenceSharedSh {
  readonly encoding: Raw4DScalarEncoding;
  readonly coefficientCount: number;
  readonly sourceStateCount: number;
  readonly extractedStateCount: number;
  readonly updateStateCount: number;
  readonly sourceBytes: number;
  readonly extractedBytes: number;
  readonly savedBytes: number;
  readonly exactBitComparison: true;
}

export interface Raw4DSequenceDescriptor {
  readonly sourceName: string;
  readonly sourceBytes: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly totalFrames: number;
  readonly boundaryFramesRemoved: number;
  readonly permanentTrackCount: number;
  readonly segments: readonly Raw4DSequenceSegment[];
  readonly matches: readonly Raw4DSequenceBoundaryMatch[];
  readonly sharedSh: Raw4DSequenceSharedSh;
}

export interface Raw4DSequenceProgress {
  readonly ratio: number;
  readonly message: string;
}

export interface Raw4DSequenceFrameLocation {
  readonly segmentIndex: number;
  readonly localFrame: number;
  readonly sourceFrame: number;
}

export interface Raw4DSequenceExtractedSegment {
  readonly encoding: Raw4DScalarEncoding;
  readonly count: number;
  readonly shCoefficientCount: number;
  readonly firstPositionBits: Uint32Array;
  readonly lastPositionBits: Uint32Array;
  readonly firstColorDcBits: Uint32Array;
  readonly lastColorDcBits: Uint32Array;
  readonly shBits: Uint32Array;
}

export interface Raw4DSequenceBoundaryMatchWork {
  readonly currentTrackMap: Int32Array;
  readonly matchedCount: number;
  readonly duplicateCandidateCount: number;
  readonly shUpdateCount: number;
  readonly nextTrackId: number;
}
