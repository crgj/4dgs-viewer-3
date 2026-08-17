import { describe, expect, it } from 'vitest';
import { GaussianEditStore } from '../../../gaussian/edit/GaussianEditStore';
import type { Raw4DAsset } from '../../../gaussian/formats/raw4d/Raw4DTypes';
import {
  computeGaussianEnvelopeMesh,
  createGaussianEnvelopeMeshFromPoints,
  GAUSSIAN_ENVELOPE_DIRECTIONS,
} from './GaussianEnvelope';

function maximumX(mesh: NonNullable<ReturnType<typeof createGaussianEnvelopeMeshFromPoints>>): number {
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < mesh.positions.length; index += 3) maximum = Math.max(maximum, mesh.positions[index]);
  return maximum;
}

describe('GaussianEnvelope', () => {
  it('creates a closed convex mesh around every input point', () => {
    const points = [
      [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
    ] as const;
    const mesh = createGaussianEnvelopeMeshFromPoints(points);
    expect(mesh).not.toBeNull();
    expect(mesh!.positions.length).toBeGreaterThanOrEqual(8 * 3);
    expect(mesh!.triangleIndices.length % 3).toBe(0);
    expect(mesh!.edgeIndices.length % 2).toBe(0);
    expect(GAUSSIAN_ENVELOPE_DIRECTIONS).toHaveLength(26);
    expect(maximumX(mesh!)).toBeGreaterThan(1);
    expect(maximumX(mesh!)).toBeLessThan(1.01);
  });

  it('excludes deleted stable IDs when rebuilding the envelope', async () => {
    const values = [
      new Float32Array([0, 1, 100, 0]),
      new Float32Array([0, 0, 0, 1]),
      new Float32Array([0, 0, 0, 1]),
    ];
    const asset = {
      sourceName: 'envelope.raw4d', sourceEncoding: 'float32', splatCount: 4, totalFrames: 1, shBands: 0,
      position: { encoding: 'float32', components: 3, keyframes: [0], values },
    } as unknown as Raw4DAsset;
    const edits = new GaussianEditStore(4);
    edits.setDeleted([2]);
    const mesh = await computeGaussianEnvelopeMesh([{ asset, edits }]);
    expect(mesh?.activePointCount).toBe(3);
    expect(maximumX(mesh!)).toBeLessThan(1.01);
  });
});
