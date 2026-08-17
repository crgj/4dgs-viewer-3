import { describe, expect, it } from 'vitest';
import {
  SCENE_AXIS_BARS,
  SCENE_AXIS_COLORS,
  SCENE_AXIS_SEGMENTS,
  SCENE_HEIGHT_RULER,
  SCENE_HEIGHT_RULER_TICKS,
} from './SceneGuides';

describe('SCENE_AXIS_COLORS', () => {
  it('uses distinct red X, green Y and blue Z colors', () => {
    const { x, y, z } = SCENE_AXIS_COLORS;
    expect(x[0]).toBeGreaterThan(Math.max(x[1], x[2]));
    expect(y[1]).toBeGreaterThan(Math.max(y[0], y[2]));
    expect(z[2]).toBeGreaterThan(Math.max(z[0], z[1]));
    expect(new Set([x.join(','), y.join(','), z.join(',')]).size).toBe(3);
    expect([x[3], y[3], z[3]]).toEqual([255, 255, 255]);
  });

  it('keeps the three direction axes at one meter', () => {
    expect(SCENE_AXIS_SEGMENTS.y.start).toEqual([0, 0, 0]);
    expect(SCENE_AXIS_SEGMENTS.y.end).toEqual([0, 1, 0]);
    expect(SCENE_AXIS_BARS.y.position).toEqual([0, 0.5, 0]);
    expect(SCENE_AXIS_BARS.y.scale).toEqual([0.015, 1, 0.015]);
    expect(SCENE_AXIS_BARS.x.scale[0]).toBe(1);
    expect(SCENE_AXIS_BARS.z.scale[2]).toBe(1);
  });

  it('builds a separate two-meter ruler with centimeter ticks and decimeter labels', () => {
    expect(SCENE_HEIGHT_RULER.height).toBe(2);
    expect(SCENE_HEIGHT_RULER_TICKS).toHaveLength(201);
    expect(SCENE_HEIGHT_RULER_TICKS[0].height).toBe(0);
    expect(SCENE_HEIGHT_RULER_TICKS.at(-1)?.height).toBe(2);
    expect(SCENE_HEIGHT_RULER_TICKS.filter((tick) => tick.label !== null).map((tick) => tick.label))
      .toEqual(Array.from({ length: 21 }, (_, index) => index * 10));
    expect(SCENE_HEIGHT_RULER_TICKS.find((tick) => tick.centimeters === 100)?.length)
      .toBeGreaterThan(SCENE_HEIGHT_RULER_TICKS.find((tick) => tick.centimeters === 10)?.length ?? 0);
    expect(SCENE_HEIGHT_RULER_TICKS.find((tick) => tick.centimeters === 10)?.length)
      .toBeGreaterThan(SCENE_HEIGHT_RULER_TICKS.find((tick) => tick.centimeters === 1)?.length ?? 0);
  });
});
