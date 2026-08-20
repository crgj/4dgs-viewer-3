import type { FourCgsBankCounts, FourCgsKeyframeStrides, FourCgsSegment } from './FourCgsTypes';

// #WDD-gpt 2026-08-16 - 此模块也由 Node 直接加载；保持运行时代码自包含，避免浏览器 bundler 与 Node ESM 的扩展名规则冲突。
function canonicalKeyframes(totalFrames: number, stride: number, count: number): number[] {
  const result: number[] = [];
  for (let frame = 0; frame < totalFrames; frame += stride) result.push(frame);
  if (result.at(-1) !== totalFrames - 1) result.push(totalFrames - 1);
  if (result.length !== count) {
    throw new Error(`RAW4D keyframe bank count mismatch: expected ${result.length}, found ${count}.`);
  }
  return result;
}

const COMPONENTS = {
  position: ['x', 'y', 'z'],
  rotation: ['w', 'x', 'y', 'z'],
  colorDc: ['0', '1', '2'],
  scale: ['0', '1', '2'],
  opacity: [''],
} as const;

function bankProperties(prefix: string, count: number, components: readonly string[]): string[] {
  const names: string[] = [];
  for (let bank = 0; bank < count; bank += 1) {
    for (const component of components) names.push(component ? `${prefix}_${bank}_${component}` : `${prefix}_${bank}`);
  }
  return names;
}

export function fourCgsDecodedPropertyNames(segment: FourCgsSegment): string[] {
  return [
    ...bankProperties('xyz_bank', segment.bankCounts.position, COMPONENTS.position),
    ...bankProperties('rot_bank', segment.bankCounts.rotation, COMPONENTS.rotation),
    ...bankProperties('f_dc_bank', segment.bankCounts.colorDc, COMPONENTS.colorDc),
    ...bankProperties('scale_bank', segment.bankCounts.scale, COMPONENTS.scale),
    ...bankProperties('opacity_bank', segment.bankCounts.opacity, COMPONENTS.opacity),
    'lifetime_mu', 'lifetime_w',
    ...Array.from({ length: 45 }, (_, coefficient) => `f_rest_${coefficient}`),
  ];
}

export function fourCgsCanonicalRaw4DPropertyNames(segment: FourCgsSegment): string[] {
  return [
    'x', 'y', 'z', 'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    ...Array.from({ length: 45 }, (_, coefficient) => `f_rest_${coefficient}`),
    'opacity', 'scale_0', 'scale_1', 'scale_2',
    'lifetime_mu', 'lifetime_w',
    ...bankProperties('xyz_bank', segment.bankCounts.position, COMPONENTS.position),
    ...bankProperties('rot_bank', segment.bankCounts.rotation, COMPONENTS.rotation),
    ...bankProperties('f_dc_bank', segment.bankCounts.colorDc, COMPONENTS.colorDc),
    ...bankProperties('scale_bank', segment.bankCounts.scale, COMPONENTS.scale),
    ...bankProperties('opacity_bank', segment.bankCounts.opacity, COMPONENTS.opacity),
  ];
}

function inferredStride(totalFrames: number, bankCount: number): number {
  if (totalFrames === 1) return 1;
  if (bankCount <= 1) throw new Error(`Cannot infer a ${totalFrames}-frame RAW4D stride from ${bankCount} bank.`);
  const stride = Math.ceil((totalFrames - 1) / (bankCount - 1));
  canonicalKeyframes(totalFrames, stride, bankCount);
  return stride;
}

export function fourCgsRaw4DKeyframeStrides(segment: FourCgsSegment): FourCgsKeyframeStrides {
  const keys = Object.keys(segment.bankCounts) as Array<keyof FourCgsBankCounts>;
  const values = {} as Record<keyof FourCgsBankCounts, number>;
  for (const key of keys) {
    const declared = segment.keyframeStrides?.[key];
    const stride = declared ?? inferredStride(segment.totalFrames, segment.bankCounts[key]);
    canonicalKeyframes(segment.totalFrames, stride, segment.bankCounts[key]);
    values[key] = stride;
  }
  return values;
}

function sourceNameForCanonical(name: string): string | null {
  if (name === 'x' || name === 'y' || name === 'z') return `xyz_bank_0_${name}`;
  if (name === 'nx' || name === 'ny' || name === 'nz') return null;
  const dc = /^f_dc_(\d+)$/.exec(name);
  if (dc) return `f_dc_bank_0_${dc[1]}`;
  if (name === 'opacity') return 'opacity_bank_0';
  const scale = /^scale_(\d+)$/.exec(name);
  if (scale) return `scale_bank_0_${scale[1]}`;
  return name;
}

export function expandFourCgsCanonicalRaw4DRows(
  segment: FourCgsSegment,
  decodedNames: readonly string[],
  decodedRows: Uint16Array,
): { readonly names: readonly string[]; readonly rows: Uint16Array } {
  const sourceIndices = new Map(decodedNames.map((name, index) => [name, index]));
  const names = fourCgsCanonicalRaw4DPropertyNames(segment);
  const mapping = names.map((name) => {
    const sourceName = sourceNameForCanonical(name);
    if (sourceName === null) return -1;
    const source = sourceIndices.get(sourceName);
    if (source === undefined) throw new Error(`4CGS cannot reconstruct canonical RAW4D property ${name} from ${sourceName}.`);
    return source;
  });
  if (decodedRows.length !== segment.gaussianCount * decodedNames.length) {
    throw new Error(`4CGS decoded row length mismatch for ${segment.name}.`);
  }
  const rows = new Uint16Array(segment.gaussianCount * names.length);
  for (let row = 0; row < segment.gaussianCount; row += 1) {
    const sourceOffset = row * decodedNames.length;
    const destinationOffset = row * names.length;
    for (let property = 0; property < mapping.length; property += 1) {
      const source = mapping[property];
      rows[destinationOffset + property] = source < 0 ? 0 : decodedRows[sourceOffset + source];
    }
  }
  return { names, rows };
}

export function fourCgsCanonicalRaw4DHeader(segment: FourCgsSegment, names: readonly string[]): Uint8Array {
  const strides = fourCgsRaw4DKeyframeStrides(segment);
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    `comment total_frames ${segment.totalFrames}`,
    ...(segment.frameRate ? [`comment frame_rate ${segment.frameRate}`] : []),
    `comment xyz_bank_keyframe_stride ${strides.position}`,
    `comment rot_bank_keyframe_stride ${strides.rotation}`,
    `comment features_dc_bank_keyframe_stride ${strides.colorDc}`,
    `comment scaling_bank_keyframe_stride ${strides.scale}`,
    `comment opacity_bank_keyframe_stride ${strides.opacity}`,
    ...(segment.positionTiming === 'per-point-lifetime-endpoints' ? ['comment position_timing per-point-lifetime-endpoints'] : []),
    ...(segment.opacityTiming === 'baked' ? ['comment opacity_timing baked'] : []),
    'comment fp16_quantized 1',
    ...names.map((name) => `comment fp16_property ${name}`),
    `element vertex ${segment.gaussianCount}`,
    ...names.map((name) => `property ushort ${name}`),
    'end_header',
  ];
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

// #WDD-gpt 2026-08-16 - 4CGS 对外解码重新生成完整 canonical Master PLY4，而不是暴露缺基础快照的内部 110 列工作布局。
export function createFourCgsCanonicalRaw4D(
  segment: FourCgsSegment,
  decodedNames: readonly string[],
  decodedRows: Uint16Array,
): Uint8Array {
  const canonical = expandFourCgsCanonicalRaw4DRows(segment, decodedNames, decodedRows);
  const header = fourCgsCanonicalRaw4DHeader(segment, canonical.names);
  const payload = new Uint8Array(canonical.rows.buffer, canonical.rows.byteOffset, canonical.rows.byteLength);
  const output = new Uint8Array(header.length + payload.length);
  output.set(header);
  output.set(payload, header.length);
  return output;
}
