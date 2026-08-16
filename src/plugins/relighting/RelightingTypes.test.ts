import { describe, expect, it } from 'vitest';
import {
  sanitizeRelightingLight,
  sanitizeRelightingSettings,
} from './RelightingTypes';

describe('RelightingTypes', () => {
  it('clamps render-target and tint parameters to supported ranges', () => {
    expect(sanitizeRelightingSettings({
      blend: 2,
      brightness: -1,
      background: Number.NaN,
      textureScale: 0.05,
    })).toEqual({
      blend: 1,
      brightness: 0,
      background: 1,
      textureScale: 0.25,
    });
  });

  it('normalizes unsafe light edits before they reach PlayCanvas', () => {
    expect(sanitizeRelightingLight({
      id: 'light-1',
      name: 'Point 1',
      position: [Number.NaN, 2, Number.POSITIVE_INFINITY],
      color: 'orange',
      intensity: 80,
      range: 0,
      castShadows: true,
    }, 4)).toMatchObject({
      position: [0, 2, 0],
      color: '#ffd7aa',
      intensity: 50,
      range: 0.01,
    });
  });
});
