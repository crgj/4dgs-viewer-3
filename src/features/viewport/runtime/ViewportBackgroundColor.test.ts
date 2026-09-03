import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWPORT_BACKGROUND_COLOR,
  isViewportBackgroundColor,
  normalizeViewportBackgroundColor,
  viewportBackgroundColorRgb,
} from './ViewportBackgroundColor';

describe('ViewportBackgroundColor', () => {
  it('normalizes valid colors and rejects malformed stored values', () => {
    expect(isViewportBackgroundColor('#12ABef')).toBe(true);
    expect(isViewportBackgroundColor('#fff')).toBe(false);
    expect(normalizeViewportBackgroundColor('#12ABef')).toBe('#12abef');
    expect(normalizeViewportBackgroundColor('#fff')).toBe(DEFAULT_VIEWPORT_BACKGROUND_COLOR);
    expect(normalizeViewportBackgroundColor('112233')).toBe(DEFAULT_VIEWPORT_BACKGROUND_COLOR);
    expect(normalizeViewportBackgroundColor(null)).toBe(DEFAULT_VIEWPORT_BACKGROUND_COLOR);
  });

  it('converts normalized channels to PlayCanvas color components', () => {
    expect(viewportBackgroundColorRgb('#ff8040')).toEqual([1, 128 / 255, 64 / 255]);
  });
});
