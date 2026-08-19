import { describe, expect, it } from 'vitest';
import { Raw4DFrameSampler } from '../../runtime/Raw4DFrameSampler';
import { Raw4DWasmExtractor } from './Raw4DWasmExtractor';
import { canImportRaw4D, parseRaw4D, readRaw4DHeader } from './Raw4DParser';
import { readRaw4DScalar } from './Raw4DValues';

const properties = [
  'x', 'y', 'z', 'nx', 'ny', 'nz',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  'f_rest_0', 'f_rest_1', 'f_rest_2', 'f_rest_3', 'f_rest_4', 'f_rest_5', 'f_rest_6', 'f_rest_7', 'f_rest_8',
  'opacity', 'scale_0', 'scale_1', 'scale_2', 'lifetime_mu', 'lifetime_w',
  'xyz_bank_0_x', 'xyz_bank_0_y', 'xyz_bank_0_z',
  'xyz_bank_1_x', 'xyz_bank_1_y', 'xyz_bank_1_z',
  'rot_bank_0_w', 'rot_bank_0_x', 'rot_bank_0_y', 'rot_bank_0_z',
  'rot_bank_1_w', 'rot_bank_1_x', 'rot_bank_1_y', 'rot_bank_1_z',
  'f_dc_bank_0_0', 'f_dc_bank_0_1', 'f_dc_bank_0_2',
  'f_dc_bank_1_0', 'f_dc_bank_1_1', 'f_dc_bank_1_2',
  'scale_bank_0_0', 'scale_bank_0_1', 'scale_bank_0_2',
  'scale_bank_1_0', 'scale_bank_1_1', 'scale_bank_1_2',
  'opacity_bank_0', 'opacity_bank_1',
];

function encodeFloat16(value: number): number {
  const float = new Float32Array([value]);
  const bits = new Uint32Array(float.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const fraction = bits & 0x7fffff;
  if (exponent === 0xff) return sign | (fraction ? 0x7e00 : 0x7c00);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    const mantissa = (fraction | 0x800000) >>> (1 - halfExponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  return sign | (halfExponent << 10) | ((fraction + 0x1000) >>> 13);
}

function syntheticRaw4D(encoding: 'float32' | 'float16' = 'float32'): Blob {
  const fp16Comments = encoding === 'float16'
    ? ['comment fp16_quantized 1']
    : [];
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment total_frames 3',
    'comment xyz_bank_keyframe_stride 2',
    'comment rot_bank_keyframe_stride 2',
    'comment features_dc_bank_keyframe_stride 2',
    'comment scaling_bank_keyframe_stride 2',
    'comment opacity_bank_keyframe_stride 2',
    ...fp16Comments,
    'element vertex 2',
    ...properties.map((name) => `property ${encoding === 'float16' ? 'ushort' : 'float'} ${name}`),
    'end_header',
    '',
  ].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const rows: Array<Record<string, number>> = [
    {
      lifetime_mu: 1, lifetime_w: 100,
      x: 0, y: 1, z: 2,
      f_dc_0: 0, f_dc_1: 1, f_dc_2: 2,
      opacity: 0, scale_0: 0, scale_1: 0, scale_2: 0,
      xyz_bank_0_x: 0, xyz_bank_0_y: 1, xyz_bank_0_z: 2,
      xyz_bank_1_x: 10, xyz_bank_1_y: 3, xyz_bank_1_z: 4,
      rot_bank_0_w: 2, rot_bank_1_z: 2,
      f_dc_bank_0_0: 0, f_dc_bank_0_1: 1, f_dc_bank_0_2: 2,
      f_dc_bank_1_0: 2, f_dc_bank_1_1: 3, f_dc_bank_1_2: 4,
      scale_bank_0_0: 0, scale_bank_0_1: 0, scale_bank_0_2: 0,
      scale_bank_1_0: Math.log(4), scale_bank_1_1: Math.log(9), scale_bank_1_2: Math.log(16),
      opacity_bank_0: 0, opacity_bank_1: Math.log(3),
      f_rest_0: 0.25,
    },
    {
      lifetime_mu: 1, lifetime_w: 100,
      x: -2, y: -3, z: -4,
      opacity: 0, scale_0: 0, scale_1: 0, scale_2: 0,
      xyz_bank_0_x: -2, xyz_bank_0_y: -3, xyz_bank_0_z: -4,
      xyz_bank_1_x: 2, xyz_bank_1_y: 3, xyz_bank_1_z: 4,
      rot_bank_0_w: 1, rot_bank_1_w: -1,
      scale_bank_0_0: 0, scale_bank_0_1: 0, scale_bank_0_2: 0,
      scale_bank_1_0: 0, scale_bank_1_1: 0, scale_bank_1_2: 0,
      opacity_bank_0: 0, opacity_bank_1: -Infinity,
    },
  ];
  const scalarBytes = encoding === 'float16' ? 2 : 4;
  const body = new ArrayBuffer(rows.length * properties.length * scalarBytes);
  const view = new DataView(body);
  rows.forEach((row, rowIndex) => {
    properties.forEach((name, propertyIndex) => {
      const offset = (rowIndex * properties.length + propertyIndex) * scalarBytes;
      if (encoding === 'float16') {
        view.setUint16(offset, encodeFloat16(row[name] ?? 0), true);
      } else {
        view.setFloat32(offset, row[name] ?? 0, true);
      }
    });
  });
  return new Blob([headerBytes, body]);
}

function legacyOptionalBankRaw4D(): Blob {
  const names = [
    'x', 'y', 'z', 'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2',
    'lifetime_mu', 'lifetime_w',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'xyz_bank_0_x', 'xyz_bank_0_y', 'xyz_bank_0_z',
    'xyz_bank_1_x', 'xyz_bank_1_y', 'xyz_bank_1_z',
  ];
  const header = [
    'ply', 'format binary_little_endian 1.0',
    'comment total_frames 3', 'comment xyz_bank_keyframe_stride 2',
    'comment rot_bank_keyframe_stride 2', 'comment features_dc_bank_keyframe_stride 2',
    'element vertex 1', ...names.map((name) => `property float ${name}`), 'end_header', '',
  ].join('\n');
  const values = new Map<string, number>([
    ['x', 1], ['y', 2], ['z', 3], ['f_dc_0', .1], ['f_dc_1', .2], ['f_dc_2', .3],
    ['opacity', -2], ['scale_0', -3], ['scale_1', -4], ['scale_2', -5],
    ['lifetime_mu', 1], ['lifetime_w', 1], ['rot_0', 1],
    ['xyz_bank_0_x', 1], ['xyz_bank_0_y', 2], ['xyz_bank_0_z', 3],
    ['xyz_bank_1_x', 4], ['xyz_bank_1_y', 5], ['xyz_bank_1_z', 6],
  ]);
  const body = new ArrayBuffer(names.length * 4);
  const view = new DataView(body);
  names.forEach((name, index) => view.setFloat32(index * 4, values.get(name) ?? 0, true));
  return new Blob([new TextEncoder().encode(header), body]);
}

describe('RAW4D parser', () => {
  it('reads binary PLY metadata and all independent keyframe banks', async () => {
    const source = syntheticRaw4D();
    const header = await readRaw4DHeader(source);
    const asset = await parseRaw4D(source, { sourceName: 'sample.raw4d' });

    expect(header.totalFrames).toBe(3);
    expect(header.vertexCount).toBe(2);
    expect(header.scalarEncoding).toBe('float32');
    expect(asset.sourceName).toBe('sample.raw4d');
    expect(asset.splatCount).toBe(2);
    expect(asset.shBands).toBe(1);
    expect(asset.position.keyframes).toEqual([0, 2]);
    expect(asset.rotation.keyframes).toEqual([0, 2]);
    expect(asset.shRest[0][0]).toBeCloseTo(0.25);
    expect(asset.opacity.values[1][1]).toBe(-Infinity);
    expect(asset.bounds).toEqual({ min: [-2, -3, -4], max: [10, 3, 4] });
    await expect(canImportRaw4D(source)).resolves.toBe(true);
  });

  it('keeps the new ushort-backed fp16 RAW4D layout bit-exact in one compact backing store', async () => {
    const source = syntheticRaw4D('float16');
    const header = await readRaw4DHeader(source);
    const asset = await parseRaw4D(source, { sourceName: 'segment_180_210.raw4d' });

    expect(header.scalarEncoding).toBe('float16');
    expect(header.recordBytes).toBe(properties.length * 2);
    expect(asset.sourceEncoding).toBe('float16');
    expect(asset.sourceName).toBe('segment_180_210.raw4d');
    expect(asset.position.values[0]).toBeInstanceOf(Uint16Array);
    expect(asset.position.values[0].buffer).toBe(asset.opacity.values[1].buffer);
    expect(asset.position.values[0].buffer).toBe(asset.shRest[0].buffer);
    expect(readRaw4DScalar(asset.position.values[0], 1, asset.sourceEncoding)).toBe(-2);
    expect(readRaw4DScalar(asset.position.values[3], 0, asset.sourceEncoding)).toBe(10);
    expect(readRaw4DScalar(asset.shRest[0], 0, asset.sourceEncoding)).toBe(0.25);
    expect(readRaw4DScalar(asset.opacity.values[1], 1, asset.sourceEncoding)).toBe(-Infinity);
    expect(asset.bounds).toEqual({ min: [-2, -3, -4], max: [10, 3, 4] });
    await expect(canImportRaw4D(source)).resolves.toBe(true);
  });

  it('uses canonical base properties when legacy files omit optional DC, scale, opacity and rotation banks', async () => {
    const asset = await parseRaw4D(legacyOptionalBankRaw4D());

    expect(asset.position.keyframes).toEqual([0, 2]);
    expect(asset.rotation.keyframes).toEqual([0]);
    expect(asset.colorDc.keyframes).toEqual([0]);
    expect(asset.scale.keyframes).toEqual([0]);
    expect(asset.opacity.keyframes).toEqual([0]);
    expect(asset.rotation.values.map((value) => value[0])).toEqual([1, 0, 0, 0]);
    expect(asset.colorDc.values.map((value) => value[0])).toEqual([
      expect.closeTo(.1), expect.closeTo(.2), expect.closeTo(.3),
    ]);
  });

  it('samples interpolated transform, SH DC, log-scale, opacity and quaternion values', async () => {
    const asset = await parseRaw4D(syntheticRaw4D());
    const sampler = new Raw4DFrameSampler(asset);
    sampler.sample(1);

    expect(sampler.properties.x[0]).toBeCloseTo(5);
    expect(sampler.properties.colorR[0]).toBeCloseTo(1);
    expect(sampler.properties.scaleX[0]).toBeCloseTo(2);
    expect(sampler.properties.scaleY[0]).toBeCloseTo(3);
    expect(sampler.properties.rotationW[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(sampler.properties.rotationZ[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(sampler.properties.opacity[0]).toBeCloseTo(0.6339746, 5);
    expect(sampler.properties.opacity[1]).toBe(0);
    expect(sampler.gsplatData.shBands).toBe(1);
  });

  it('rejects truncated payloads before allocating animation tracks', async () => {
    const source = syntheticRaw4D();
    const truncated = source.slice(0, source.size - 8);
    await expect(parseRaw4D(truncated)).rejects.toThrow(/truncated/);
  });

  it('rejects zero rotation quaternions', async () => {
    const source = syntheticRaw4D();
    const header = await readRaw4DHeader(source);
    const bytes = new Uint8Array(await source.arrayBuffer());
    const rotation = header.propertyNames.indexOf('rot_bank_0_w');
    const view = new DataView(bytes.buffer);
    for (let component = 0; component < 4; component += 1) {
      view.setFloat32(header.dataOffset + (rotation + component) * 4, 0, true);
    }
    await expect(parseRaw4D(new Blob([bytes]))).rejects.toThrow(/quaternion/);
  });

  it('keeps negative-infinity transparency but rejects positive-infinity opacity', async () => {
    expect((await parseRaw4D(syntheticRaw4D())).opacity.values[1][1]).toBe(-Infinity);
    const source = syntheticRaw4D();
    const header = await readRaw4DHeader(source);
    const bytes = new Uint8Array(await source.arrayBuffer());
    const opacity = header.propertyNames.indexOf('opacity_bank_1');
    const secondRow = header.dataOffset + header.recordBytes;
    new DataView(bytes.buffer).setFloat32(secondRow + opacity * 4, Infinity, true);
    await expect(parseRaw4D(new Blob([bytes]))).rejects.toThrow(/opacity logit/);
  });

  it('preserves finite negative lifetime widths instead of rejecting the complete PLY4 file', async () => {
    const source = syntheticRaw4D();
    const header = await readRaw4DHeader(source);
    const bytes = new Uint8Array(await source.arrayBuffer());
    const lifetimeW = header.propertyNames.indexOf('lifetime_w');
    new DataView(bytes.buffer).setFloat32(header.dataOffset + lifetimeW * 4, -0.005, true);

    const asset = await parseRaw4D(new Blob([bytes]));

    expect(asset.lifetimeW[0]).toBeCloseTo(-0.005);
  });

  it('decodes through WASM directly into shared TypedArray storage', async () => {
    const extractor = await Raw4DWasmExtractor.create();
    const asset = await parseRaw4D(syntheticRaw4D(), {
      createStorage: (length) => new Float32Array(new SharedArrayBuffer(length * 4)),
      extractChunk: extractor.extract,
    });

    expect(asset.position.values[0].buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...asset.position.values[0]]).toEqual([0, -2]);
    expect([...asset.position.values[3]]).toEqual([10, 2]);
    expect(asset.shRest[0][0]).toBeCloseTo(0.25);
  });
});
