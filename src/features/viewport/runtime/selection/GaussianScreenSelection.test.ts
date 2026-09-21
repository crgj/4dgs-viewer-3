import { describe, expect, it } from 'vitest';
import {
  createGaussianBrushSelectionRegion,
  createGaussianPolygonSelectionRegion,
  createGaussianRectSelectionRegion,
  gaussianSelectionIdsFromMask,
  gaussianSelectionModeFromModifiers,
  gaussianSelectionRectContains,
  gaussianScreenEllipseContains,
  gaussianBrushScreenMetrics,
  isGaussianSelectionAddFeedbackKey,
  isGaussianSelectionPointerButton,
  normalizeGaussianSelectionRect,
} from './GaussianScreenSelection';

describe('GaussianScreenSelection', () => {
  it('reserves only the left button for selection tools', () => {
    expect(isGaussianSelectionPointerButton(0)).toBe(true);
    expect(isGaussianSelectionPointerButton(1)).toBe(false);
    expect(isGaussianSelectionPointerButton(2)).toBe(false);
  });

  it('uses only the left Ctrl or left Command key for persistent add-mode feedback', () => {
    expect(isGaussianSelectionAddFeedbackKey('ControlLeft')).toBe(true);
    expect(isGaussianSelectionAddFeedbackKey('MetaLeft')).toBe(true);
    expect(isGaussianSelectionAddFeedbackKey('ControlRight')).toBe(false);
    expect(isGaussianSelectionAddFeedbackKey('ShiftLeft')).toBe(false);
  });

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

  it('selects a projected ellipse whenever its footprint intersects the screen region', () => {
    const ellipse = {
      centerX: 0,
      centerY: 0,
      axis1X: 10,
      axis1Y: 0,
      axis2X: 0,
      axis2Y: 2,
    };
    expect(gaussianScreenEllipseContains(ellipse, 9, 0)).toBe(true);
    expect(gaussianScreenEllipseContains(ellipse, 10.1, 0)).toBe(false);

    // 四个角均在椭圆外，但窄矩形横跨椭圆右端，必须按边界相交命中。
    expect(createGaussianRectSelectionRegion({ left: 9.9, right: 10.1, top: -0.3, bottom: 0.3 })
      .intersectsEllipse(ellipse)).toBe(true);
    expect(createGaussianRectSelectionRegion({ left: 10.2, right: 11, top: -0.3, bottom: 0.3 })
      .intersectsEllipse(ellipse)).toBe(false);

    const polygon = createGaussianPolygonSelectionRegion([
      { x: 8.9, y: -0.2 }, { x: 10.2, y: -0.2 }, { x: 10.2, y: 0.2 }, { x: 8.9, y: 0.2 },
    ]);
    expect(polygon.intersectsEllipse(ellipse)).toBe(true);
    expect(createGaussianBrushSelectionRegion([{ x: 10.5, y: 0 }], 1).intersectsEllipse(ellipse)).toBe(true);
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
    expect(gaussianSelectionModeFromModifiers({ ...base, ctrlKey: true })).toBe('add');
    expect(gaussianSelectionModeFromModifiers({ ...base, metaKey: true })).toBe('add');
    expect(gaussianSelectionModeFromModifiers({ ...base, shiftKey: true })).toBe('remove');
    expect(gaussianSelectionModeFromModifiers({ ...base, altKey: true })).toBe('remove');
    expect(gaussianSelectionModeFromModifiers({ ...base, ctrlKey: true, shiftKey: true })).toBe('remove');
    expect(gaussianSelectionIdsFromMask(Uint8Array.from([0, 1, 0, 1]))).toEqual([1, 3]);
  });
});
