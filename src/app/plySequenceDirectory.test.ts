import { describe, expect, it } from 'vitest';
import {
  PLY_SEQUENCE_DIRECTORY_PICKER_OPTIONS,
  isDirectoryPickerAbort,
} from './plySequenceDirectory';

describe('PLY sequence directory picker', () => {
  it('starts in Downloads and remembers the approved dedicated folder', () => {
    expect(PLY_SEQUENCE_DIRECTORY_PICKER_OPTIONS).toEqual({
      id: 'dong-editor-3-ply-sequence-v2',
      mode: 'readwrite',
      startIn: 'downloads',
    });
  });

  it('distinguishes picker aborts from actionable failures', () => {
    expect(isDirectoryPickerAbort(new DOMException('cancelled', 'AbortError'))).toBe(true);
    expect(isDirectoryPickerAbort(new DOMException('blocked', 'SecurityError'))).toBe(false);
    expect(isDirectoryPickerAbort(new Error('write failed'))).toBe(false);
  });
});
