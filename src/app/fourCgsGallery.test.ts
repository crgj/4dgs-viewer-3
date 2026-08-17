import { describe, expect, it, vi } from 'vitest';
import {
  fetchFourCgsGalleryFile,
  parseFourCgsGalleryManifest,
} from './fourCgsGallery';

const sourceItem = {
  id: 'red', name: 'Red', file: 'red.4cgs', snapshot: 'thumbnails/red.webp',
  description: 'A complete gallery description.', fileBytes: 4, sourceBytes: 16,
  frameCount: 61, frameRange: [270, 330] as const, segmentCount: 2,
  gaussianCount: 10, sourceGaussianCount: 12, deletedGaussianCount: 2,
  codec: 'V2.6', codecName: 'codec-v26', tags: ['动态'],
};

describe('4CGS gallery manifest', () => {
  it('validates metadata and resolves asset URLs relative to the manifest', () => {
    const manifest = parseFourCgsGalleryManifest({
      version: 1, updatedAt: '2026-08-17', items: [sourceItem],
    }, 'https://viewer.test/editor/4cgs/gallery.json');
    expect(manifest.items[0].assetUrl).toBe('https://viewer.test/editor/4cgs/red.4cgs');
    expect(manifest.items[0].snapshotUrl).toBe('https://viewer.test/editor/4cgs/thumbnails/red.webp');
  });

  it('rejects incomplete cards instead of showing missing descriptions', () => {
    expect(() => parseFourCgsGalleryManifest({
      version: 1, updatedAt: '2026-08-17', items: [{ ...sourceItem, description: '' }],
    }, 'https://viewer.test/4cgs/gallery.json')).toThrow(/description/);
  });

  it('downloads an exact-size File and reports streaming progress', async () => {
    const manifest = parseFourCgsGalleryManifest({
      version: 1, updatedAt: '2026-08-17', items: [sourceItem],
    }, 'https://viewer.test/4cgs/gallery.json');
    const progress = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'content-length': '4' }, status: 200,
    }));
    const file = await fetchFourCgsGalleryFile(manifest.items[0], progress, fetcher);
    expect(file.name).toBe('red.4cgs');
    expect(file.size).toBe(4);
    expect(progress).toHaveBeenLastCalledWith(1);
  });
});
