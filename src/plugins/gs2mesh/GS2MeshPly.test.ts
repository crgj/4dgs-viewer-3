import { describe, expect, it } from 'vitest';
import { encodeGS2MeshPly, parseGS2MeshPly } from './GS2MeshPly';

describe('parseGS2MeshPly', () => {
  it('loads colored ASCII vertices and triangulates polygon faces', () => {
    const source = [
      'ply', 'format ascii 1.0', 'element vertex 4',
      'property float x', 'property float y', 'property float z',
      'property uchar red', 'property uchar green', 'property uchar blue',
      'element face 1', 'property list uchar int vertex_indices', 'end_header',
      '0 0 0 255 0 0', '1 0 0 0 255 0', '1 1 0 0 0 255', '0 1 0 255 255 255',
      '4 0 1 2 3', '',
    ].join('\n');
    const encoded = new TextEncoder().encode(source);
    const mesh = parseGS2MeshPly(encoded.buffer);
    expect(mesh.positions).toHaveLength(12);
    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([...mesh.colors.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(mesh.normals).toBeNull();
  });

  it('round-trips a browser-generated binary PLY', () => {
    const encoded = encodeGS2MeshPly({
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      colors: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
      indices: Uint32Array.from([0, 1, 2]),
    });
    const decoded = parseGS2MeshPly(encoded);
    expect([...decoded.indices]).toEqual([0, 1, 2]);
    expect([...decoded.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect([...decoded.colors.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(decoded.normals).not.toBeNull();
  });
});
