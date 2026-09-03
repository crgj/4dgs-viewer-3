import { describe, expect, it } from 'vitest';
import { clampPluginWindowPosition } from './PluginWindowBounds';

describe('clampPluginWindowPosition', () => {
  it('keeps a dragged window inside the workspace after its result content grows', () => {
    expect(clampPluginWindowPosition({
      position: { x: 180, y: 220 },
      workspaceWidth: 1000,
      workspaceHeight: 620,
      windowWidth: 640,
      windowHeight: 580,
    })).toEqual({ x: 172, y: 12 });
  });

  it('recenters an oversized window instead of preserving an unreachable offset', () => {
    expect(clampPluginWindowPosition({
      position: { x: -100, y: 100 },
      workspaceWidth: 420,
      workspaceHeight: 320,
      windowWidth: 420,
      windowHeight: 320,
    })).toEqual({ x: 0, y: 0 });
  });

  it('preserves positions that remain reachable', () => {
    expect(clampPluginWindowPosition({
      position: { x: -70, y: 40 },
      workspaceWidth: 1000,
      workspaceHeight: 700,
      windowWidth: 600,
      windowHeight: 420,
    })).toEqual({ x: -70, y: 40 });
  });
});
