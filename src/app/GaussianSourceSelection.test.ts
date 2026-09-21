import { describe, expect, it } from 'vitest';
import { gaussianSourceSelectionKind } from './GaussianSourceSelection';

describe('Gaussian source selection', () => {
  it('accepts multiple 4CGS files as one container sequence', () => {
    expect(gaussianSourceSelectionKind([
      new File([], 'take.part-02-of-03.4cgs'),
      new File([], 'take.part-01-of-03.4cgs'),
    ])).toBe('fourcgs-sequence');
  });

  it('keeps RAW4D sequences and rejects mixed multi-file formats', () => {
    expect(gaussianSourceSelectionKind([new File([], 'a.raw4d'), new File([], 'b.ply4')])).toBe('raw4d-sequence');
    expect(gaussianSourceSelectionKind([new File([], 'a.4cgs'), new File([], 'b.raw4d')])).toBe('invalid');
  });
});
