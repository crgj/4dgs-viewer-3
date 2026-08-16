import { describe, expect, it, vi } from 'vitest';
import { GaussianFormatRegistry } from './GaussianFormatRegistry';
import type { GaussianFormatAdapter } from './GaussianFormatAdapter';

function adapter(id: string, extensions: string[]): GaussianFormatAdapter {
  return {
    id,
    displayName: id.toUpperCase(),
    extensions,
    canImport: vi.fn(() => true),
    import: vi.fn(async () => ({ id })),
  };
}

describe('GaussianFormatRegistry', () => {
  it('matches registered adapters case-insensitively by extension', () => {
    const registry = new GaussianFormatRegistry();
    registry.register(adapter('ply', ['ply']));
    registry.register(adapter('spz', ['spz']));

    expect(registry.findByExtension('SCENE.PLY').map((item) => item.id)).toEqual(['ply']);
    expect(registry.findByExtension('scene.unknown')).toEqual([]);
  });

  it('rejects duplicate adapter ids', () => {
    const registry = new GaussianFormatRegistry();
    registry.register(adapter('ply', ['ply']));

    expect(() => registry.register(adapter('ply', ['ply4']))).toThrow(/already registered/);
  });
});
