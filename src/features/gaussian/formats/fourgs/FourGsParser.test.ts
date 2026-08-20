import { describe, expect, it } from 'vitest';
import { Raw4DFrameSampler } from '../../runtime/Raw4DFrameSampler';
import { parseFourGs, readFourGsHeader } from './FourGsParser';

function fourGsFile(frameCount = 3): File {
  const properties = [
    'x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'velocity_per_frame_0', 'velocity_per_frame_1', 'velocity_per_frame_2',
    'frame_center', 'sigma_frames', 'radius_frames',
  ];
  const header = [
    'ply', 'format binary_little_endian 1.0', 'comment easytimegspp-4dgs version 2',
    `comment normalized_time_frames 0 ${frameCount - 1} ${frameCount}`,
    'element vertex 1', ...properties.map((name) => `property float ${name}`), 'end_header', '',
  ].join('\n');
  const values = [
    1, 2, 3, .1, .2, .3, 0, -2, -3, -4, 1, 0, 0, 0,
    2, 0, 0, 1, 1, 0,
  ];
  const body = new ArrayBuffer(values.length * 4);
  const view = new DataView(body);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return new File([header, body], 'linear.4gs');
}

describe('EasyTimeGS++ 4GS v2 parser', () => {
  it('reads each file frame count and converts linear motion to endpoint banks', async () => {
    const file = fourGsFile(3);
    const header = await readFourGsHeader(file);
    expect(header.frameCount).toBe(3);
    const asset = await parseFourGs(file, { sourceName: file.name });
    expect(asset.totalFrames).toBe(3);
    expect(asset.position.keyframes).toEqual([0, 2]);
    expect(asset.position.values.map((value) => value[0])).toEqual([-1, 2, 3, 3, 2, 3]);
    expect(asset.scale.keyframes).toEqual([0]);
    expect(asset.rotation.keyframes).toEqual([0]);
    expect(asset.opacity.keyframes).toEqual([0, 1, 2]);
    expect(asset.opacity.values[1][0]).toBeCloseTo(0, 6);
    expect(asset.opacity.values[0][0]).toBeCloseTo(-1.48988, 4);
    expect(asset.temporalLayout?.pointGroups[0].trackKeyframes.position).toEqual([0, 2]);

    // #WDD-gpt 2026-08-20 - CPU 回退采样必须使用每个点自己的生命周期端点，且不得对已烘焙透明度再乘旧门控。
    const sampler = new Raw4DFrameSampler(asset);
    expect(sampler.properties.x[0]).toBeCloseTo(-1, 6);
    expect(sampler.properties.opacity[0]).toBeCloseTo(1 / (1 + Math.exp(1.48988)), 5);
    sampler.sample(1);
    expect(sampler.properties.x[0]).toBeCloseTo(1, 6);
    sampler.sample(2);
    expect(sampler.properties.x[0]).toBeCloseTo(3, 6);
  });

  it('rejects a payload whose byte length does not close exactly', async () => {
    const file = fourGsFile();
    const extended = new File([file, new Uint8Array([1])], 'extended.4gs');
    await expect(readFourGsHeader(extended)).rejects.toThrow(/文件长度不闭合/);
  });
});
