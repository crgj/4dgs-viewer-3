import { describe, expect, it } from 'vitest';
import { GaussianAssetImporter, detectGaussianSourceFormat } from './GaussianAssetImporter';
import { decodePlyGaussian } from './PlyGaussianDecoder';

function binaryPlyFile(): File {
  const properties = [
    'x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
  ];
  const header = [
    'ply', 'format binary_little_endian 1.0', 'element vertex 2',
    ...properties.map((name) => `property float ${name}`), 'end_header', '',
  ].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const rows = [
    [1, 2, 3, .1, .2, .3, 2, -3, -3, -3, 1, 0, 0, 0],
    [-1, 4, 0, .4, .5, .6, 3, -2, -2, -2, 1, 0, 0, 0],
  ];
  const body = new ArrayBuffer(rows.length * properties.length * 4);
  const view = new DataView(body);
  rows.flat().forEach((value, index) => view.setFloat32(index * 4, value, true));
  return new File([headerBytes, body], 'sample.ply');
}

describe('PLY Gaussian decoder', () => {
  it('detects all supported source formats', () => {
    expect(detectGaussianSourceFormat('a.raw4d')).toBe('RAW4D');
    expect(detectGaussianSourceFormat('a.PLY4')).toBe('PLY4');
    expect(detectGaussianSourceFormat('a.sog')).toBe('SOG');
    expect(detectGaussianSourceFormat('a.ply')).toBe('PLY');
    expect(detectGaussianSourceFormat('a.obj')).toBeNull();
  });

  it('caps the RAW4D loader pool to the measured safe parallelism', () => {
    // #WDD-gpt 2026-08-16 - 防止后续误把大数组 Loader Worker 无上限扩展到逻辑核心数。
    const maximum = new GaussianAssetImporter(99);
    const minimum = new GaussianAssetImporter(0);
    expect(maximum.raw4DWorkerCount).toBe(3);
    expect(minimum.raw4DWorkerCount).toBe(1);
    maximum.destroy();
    minimum.destroy();
  });

  it('decodes static binary PLY into the unified canonical asset', async () => {
    const imported = await decodePlyGaussian(binaryPlyFile(), { cpuBudgetBytes: 1_000_000 });
    expect(imported.format).toBe('PLY');
    expect(imported.asset.splatCount).toBe(2);
    expect(imported.asset.totalFrames).toBe(1);
    expect(imported.asset.position.values[0]).toEqual(new Float32Array([1, -1]));
    expect(imported.asset.bounds.min).toEqual([-1, 2, 0]);
    expect(imported.asset.bounds.max).toEqual([1, 4, 3]);
    expect(imported.cpuResidentBytes).toBeGreaterThan(0);
  });

  it('preserves PLY4 position banks as canonical time tracks', async () => {
    const text = [
      'ply', 'format ascii 1.0', 'comment total_frames 3',
      'comment xyz_bank_keyframe_stride 2', 'element vertex 1',
      'property float xyz_bank_0_x', 'property float xyz_bank_0_y', 'property float xyz_bank_0_z',
      'property float xyz_bank_1_x', 'property float xyz_bank_1_y', 'property float xyz_bank_1_z',
      'property float f_dc_0', 'property float f_dc_1', 'property float f_dc_2',
      'property float opacity', 'property float scale_0', 'property float scale_1', 'property float scale_2',
      'end_header', '0 1 2 3 4 5 0 0 0 2 -3 -3 -3', '',
    ].join('\n');
    const imported = await decodePlyGaussian(new File([text], 'animated.ply4'), { cpuBudgetBytes: 1_000_000 });
    expect(imported.format).toBe('PLY4');
    expect(imported.asset.totalFrames).toBe(3);
    expect(imported.asset.position.keyframes).toEqual([0, 2]);
    expect(imported.asset.position.values[3][0]).toBe(3);
    expect(imported.asset.rotation.values.map((component) => component[0])).toEqual([1, 0, 0, 0]);
  });

  it('loads scale and opacity banks and places an irregular final bank at total_frames - 1', async () => {
    const position = Array.from({ length: 5 }, (_, bank) => ['x', 'y', 'z'].map((axis) => `xyz_bank_${bank}_${axis}`)).flat();
    const scale = Array.from({ length: 5 }, (_, bank) => ['0', '1', '2'].map((axis) => `scale_bank_${bank}_${axis}`)).flat();
    const opacity = Array.from({ length: 5 }, (_, bank) => `opacity_bank_${bank}`);
    const properties = [
      ...position, 'f_dc_0', 'f_dc_1', 'f_dc_2', 'scale_0', 'scale_1', 'scale_2', 'opacity',
      ...scale, ...opacity,
    ];
    const text = [
      'ply', 'format ascii 1.0', 'comment total_frames 11',
      'comment xyz_bank_keyframe_stride 3', 'comment features_dc_bank_keyframe_stride 3',
      'comment scaling_bank_keyframe_stride 3', 'comment opacity_bank_keyframe_stride 3',
      'element vertex 1', ...properties.map((name) => `property float ${name}`), 'end_header',
      properties.map((_, index) => String(index)).join(' '), '',
    ].join('\n');
    const imported = await decodePlyGaussian(new File([text], 'irregular-final.ply4'), { cpuBudgetBytes: 1_000_000 });

    expect(imported.asset.position.keyframes).toEqual([0, 3, 6, 9, 10]);
    expect(imported.asset.scale.keyframes).toEqual([0, 3, 6, 9, 10]);
    expect(imported.asset.opacity.keyframes).toEqual([0, 3, 6, 9, 10]);
    expect(imported.asset.opacity.values).toHaveLength(5);
  });

  it('accepts explicit scalar widths and canonicalizes legacy XYZW rotation banks', async () => {
    const text = [
      'ply', '  format ascii 1.0', 'comment legacy total_frames 5',
      'comment metadata rot_bank_component_order xyzw', 'element vertex 1',
      'property float32 xyz_bank_0_x', 'property float32 xyz_bank_0_y', 'property float32 xyz_bank_0_z',
      'property float32 f_dc_0', 'property float32 f_dc_1', 'property float32 f_dc_2',
      'property float32 opacity', 'property float32 scale_0', 'property float32 scale_1', 'property float32 scale_2',
      'property float32 rot_bank_0_w', 'property float32 rot_bank_0_x',
      'property float32 rot_bank_0_y', 'property float32 rot_bank_0_z',
      'end_header', '1 2 3 0 0 0 2 -3 -3 -3 .1 .2 .3 .9', '',
    ].join('\n');
    const imported = await decodePlyGaussian(new File([text], 'legacy.ply4'), { cpuBudgetBytes: 1_000_000 });
    expect(imported.asset.totalFrames).toBe(5);
    expect(imported.asset.rotation.values.map((component) => component[0])).toEqual([
      expect.closeTo(.9), expect.closeTo(.1), expect.closeTo(.2), expect.closeTo(.3),
    ]);
  });
});
