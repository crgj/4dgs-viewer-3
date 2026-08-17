import { describe, expect, it } from 'vitest';
import {
  createGaussianBrushSelectionRegion,
  createGaussianPolygonSelectionRegion,
  createGaussianRectSelectionRegion,
  gaussianSelectionIdsFromMask,
  gaussianSelectionModeFromModifiers,
  gaussianSelectionRectContains,
  gaussianBrushScreenMetrics,
  normalizeGaussianSelectionRect,
} from './GaussianScreenSelection';

describe('GaussianScreenSelection', () => {
  it('normalizes reverse drags and expands clicks to a pick box', () => {
    expect(normalizeGaussianSelectionRect(20, 30, 10, 5)).toEqual({ left: 10, top: 5, right: 20, bottom: 30 });
    expect(normalizeGaussianSelectionRect(10, 10, 10, 10, 6)).toEqual({ left: 7, top: 7, right: 13, bottom: 13 });
  });

  it('checks inclusive screen bounds', () => {
    const rect = { left: 2, top: 3, right: 8, bottom: 9 };
    expect(gaussianSelectionRectContains(rect, 2, 9)).toBe(true);
    expect(gaussianSelectionRectContains(rect, 8.1, 9)).toBe(false);
  });

  it('creates rectangle, brush-path and polygon hit regions', () => {
    const rectangle = createGaussianRectSelectionRegion({ left: 2, top: 3, right: 8, bottom: 9 });
    expect(rectangle.contains(5, 5)).toBe(true);
    expect(rectangle.contains(9, 5)).toBe(false);

    const brush = createGaussianBrushSelectionRegion([{ x: 5, y: 5 }, { x: 25, y: 5 }], 4);
    expect(brush.contains(15, 7)).toBe(true);
    expect(brush.contains(15, 10)).toBe(false);

    const polygon = createGaussianPolygonSelectionRegion([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 },
    ]);
    expect(polygon.contains(5, 5)).toBe(true);
    expect(polygon.contains(9, 9)).toBe(false);
    expect(polygon.contains(5, 10)).toBe(true);
  });

  it('keeps brush hit, cursor and trail dimensions on one CSS-pixel radius', () => {
    expect(gaussianBrushScreenMetrics(48)).toEqual({ radius: 48, diameter: 96, visibleDiameter: 98 });
    expect(gaussianBrushScreenMetrics(1)).toEqual({ radius: 2, diameter: 4, visibleDiameter: 6 });
    const brush = createGaussianBrushSelectionRegion([{ x: 100, y: 100 }], 48);
    expect(brush.contains(148, 100)).toBe(true);
    expect(brush.contains(148.01, 100)).toBe(false);
  });

  it('maps editor modifiers and extracts stable IDs', () => {
    const base = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(gaussianSelectionModeFromModifiers(base)).toBe('replace');
    expect(gaussianSelectionModeFromModifiers({ ...base, shiftKey: true })).toBe('add');
    expect(gaussianSelectionModeFromModifiers({ ...base, altKey: true, shiftKey: true })).toBe('remove');
    expect(gaussianSelectionModeFromModifiers({ ...base, metaKey: true })).toBe('toggle');
    expect(gaussianSelectionIdsFromMask(Uint8Array.from([0, 1, 0, 1]))).toEqual([1, 3]);
  });
});
