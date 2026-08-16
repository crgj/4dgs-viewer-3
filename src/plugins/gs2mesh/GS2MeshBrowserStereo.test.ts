import { describe, expect, it } from 'vitest';
import {
  foregroundMask,
  rgbaToGray,
} from './GS2MeshBrowserStereo';

describe('GS2Mesh browser image preparation', () => {
  it('converts RGBA to luminance and separates a foreground patch from the border', () => {
    const width = 8;
    const height = 8;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      rgba[pixel * 4] = 10;
      rgba[pixel * 4 + 1] = 10;
      rgba[pixel * 4 + 2] = 10;
      rgba[pixel * 4 + 3] = 255;
    }
    const center = (3 * width + 3) * 4;
    rgba[center] = 200;
    rgba[center + 1] = 120;
    rgba[center + 2] = 40;
    expect(rgbaToGray(rgba)[3 * width + 3]).toBeGreaterThan(100);
    const mask = foregroundMask(rgba, width, height);
    expect(mask[3 * width + 3]).toBe(1);
    expect(mask[0]).toBe(0);
  });
});
