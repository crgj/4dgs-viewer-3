import { describe, expect, it } from 'vitest';
import { orientNormalsOutward } from './GS2MeshSceneObject';

const positions = Float32Array.from([
  1, 0, 0,
  -1, 0, 0,
  0, 1, 0,
  0, -1, 0,
  0, 0, 1,
  0, 0, -1,
]);

describe('GS2Mesh relighting normals', () => {
  it('flips a consistently inward normal field once', () => {
    const inward = Float32Array.from(positions, (value) => -value);
    const oriented = orientNormalsOutward(positions, inward);

    // #WDD-gpt 2026-08-16 - A light on the positive side must meet a positive-facing normal instead of illuminating the opposite side of the proxy.
    expect([...oriented]).toEqual([...positions]);
  });

  it('keeps an already outward normal field unchanged', () => {
    expect(orientNormalsOutward(positions, positions)).toBe(positions);
  });

  it('uses closed-volume winding for concave-safe orientation', () => {
    const cubePositions = Float32Array.from([
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
    ]);
    const outwardIndices = Uint32Array.from([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
      0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    ]);
    const inwardIndices = Uint32Array.from(outwardIndices, (_, offset) => {
      const triangleOffset = Math.floor(offset / 3) * 3;
      return outwardIndices[triangleOffset + (offset % 3 === 1 ? 2 : offset % 3 === 2 ? 1 : 0)];
    });
    const inwardNormals = Float32Array.from(cubePositions, (value) => -value / Math.sqrt(3));
    const oriented = orientNormalsOutward(cubePositions, inwardNormals, inwardIndices);

    // #WDD-gpt 2026-08-16 - Signed volume remains reliable for closed non-spherical bodies where the bounds-center heuristic can choose the wrong global side.
    expect(oriented[0]).toBeCloseTo(-1 / Math.sqrt(3));
    expect(oriented[1]).toBeCloseTo(-1 / Math.sqrt(3));
    expect(oriented[2]).toBeCloseTo(-1 / Math.sqrt(3));
  });
});
