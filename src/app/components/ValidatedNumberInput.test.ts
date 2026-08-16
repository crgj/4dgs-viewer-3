import { describe, expect, it } from 'vitest';
import { shouldStartNumberScrub, validateNumberDraft } from './ValidatedNumberInput';

describe('validated number input', () => {
  it('keeps the previous value when the completed draft is invalid', () => {
    expect(validateNumberDraft('-', 2, { min: 0, max: 10 })).toEqual({ value: 2, status: 'invalid' });
    expect(validateNumberDraft('1e', 2, { min: 0, max: 10 })).toEqual({ value: 2, status: 'invalid' });
  });

  it('clamps completed values to the field range', () => {
    expect(validateNumberDraft('-3', 1, { min: 0.001, max: 1000, precision: 3 })).toEqual({ value: 0.001, status: 'corrected' });
    expect(validateNumberDraft('999', 8, { min: 4, max: 16, integer: true })).toEqual({ value: 16, status: 'corrected' });
  });

  it('applies integer and decimal field characteristics only on commit', () => {
    expect(validateNumberDraft('7.6', 4, { min: 4, max: 16, integer: true })).toEqual({ value: 8, status: 'corrected' });
    expect(validateNumberDraft('0.2867', 0.28, { min: 0.08, max: 0.7, precision: 2 })).toEqual({ value: 0.29, status: 'corrected' });
  });

  it('starts scrub only for an intentional horizontal drag', () => {
    expect(shouldStartNumberScrub(5, 0)).toBe(false);
    expect(shouldStartNumberScrub(8, 7)).toBe(false);
    expect(shouldStartNumberScrub(8, 2)).toBe(true);
    expect(shouldStartNumberScrub(-8, 2)).toBe(true);
  });
});
