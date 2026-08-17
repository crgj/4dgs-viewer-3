export type Raw4DTrackName = 'position' | 'rotation' | 'colorDc' | 'scale' | 'opacity';

export interface Raw4DTrackDefinition {
  readonly name: Raw4DTrackName;
  readonly prefix: string;
  readonly components: readonly string[];
  readonly strideComment: string;
  readonly baseProperties: readonly string[];
  readonly bankRequired: boolean;
  readonly legacyStrideFallbackComment?: string;
}

export const RAW4D_TRACK_DEFINITIONS: Readonly<Record<Raw4DTrackName, Raw4DTrackDefinition>> = {
  position: {
    name: 'position',
    prefix: 'xyz_bank',
    components: ['x', 'y', 'z'],
    strideComment: 'xyz_bank_keyframe_stride',
    baseProperties: ['x', 'y', 'z'],
    bankRequired: true,
  },
  rotation: {
    name: 'rotation',
    prefix: 'rot_bank',
    components: ['w', 'x', 'y', 'z'],
    strideComment: 'rot_bank_keyframe_stride',
    baseProperties: ['rot_0', 'rot_1', 'rot_2', 'rot_3'],
    bankRequired: false,
  },
  colorDc: {
    name: 'colorDc',
    prefix: 'f_dc_bank',
    components: ['0', '1', '2'],
    strideComment: 'features_dc_bank_keyframe_stride',
    baseProperties: ['f_dc_0', 'f_dc_1', 'f_dc_2'],
    bankRequired: false,
  },
  scale: {
    name: 'scale',
    prefix: 'scale_bank',
    components: ['0', '1', '2'],
    strideComment: 'scaling_bank_keyframe_stride',
    baseProperties: ['scale_0', 'scale_1', 'scale_2'],
    bankRequired: false,
    legacyStrideFallbackComment: 'features_dc_bank_keyframe_stride',
  },
  opacity: {
    name: 'opacity',
    prefix: 'opacity_bank',
    components: [''],
    strideComment: 'opacity_bank_keyframe_stride',
    baseProperties: ['opacity'],
    bankRequired: false,
    legacyStrideFallbackComment: 'features_dc_bank_keyframe_stride',
  },
};

export const RAW4D_CANONICAL_BASE_PROPERTIES = [
  'x', 'y', 'z',
  'nx', 'ny', 'nz',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  'opacity',
  'scale_0', 'scale_1', 'scale_2',
  'lifetime_mu', 'lifetime_w',
] as const;

export function raw4DTrackPropertyName(
  definition: Raw4DTrackDefinition,
  bank: number,
  component: string,
): string {
  return component ? `${definition.prefix}_${bank}_${component}` : `${definition.prefix}_${bank}`;
}

export function raw4DBankCount(
  propertyNames: readonly string[],
  definition: Raw4DTrackDefinition,
): number {
  let maximum = -1;
  const expression = new RegExp(`^${definition.prefix}_(\\d+)(?:_|$)`);
  for (const name of propertyNames) {
    const match = expression.exec(name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

export function raw4DCanonicalKeyframes(totalFrames: number, stride: number, count?: number): number[] {
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0) {
    throw new Error(`Invalid RAW4D total_frames: ${totalFrames}.`);
  }
  if (!Number.isSafeInteger(stride) || stride <= 0) {
    throw new Error(`Invalid RAW4D keyframe stride: ${stride}.`);
  }
  const result: number[] = [];
  for (let frame = 0; frame < totalFrames; frame += stride) result.push(frame);
  if (result.at(-1) !== totalFrames - 1) result.push(totalFrames - 1);
  if (count !== undefined && result.length !== count) {
    throw new Error(`RAW4D keyframe bank count mismatch: expected ${result.length}, found ${count}.`);
  }
  return result;
}

export function raw4DTrackStride(
  comments: ReadonlyMap<string, string>,
  definition: Raw4DTrackDefinition,
): number {
  const declared = comments.get(definition.strideComment);
  const fallback = definition.legacyStrideFallbackComment
    ? comments.get(definition.legacyStrideFallbackComment) ?? '1'
    : undefined;
  const value = declared ?? fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid RAW4D ${definition.strideComment}: ${value ?? 'missing'}.`);
  }
  return parsed;
}

export function raw4DShPropertyNames(propertyNames: readonly string[]): string[] {
  const names = propertyNames
    .filter((name) => /^f_rest_\d+$/.test(name))
    .sort((left, right) => Number(left.slice(7)) - Number(right.slice(7)));
  for (let coefficient = 0; coefficient < names.length; coefficient += 1) {
    if (names[coefficient] !== `f_rest_${coefficient}`) {
      throw new Error(`RAW4D SH properties must be continuous from f_rest_0; found ${names[coefficient]}.`);
    }
  }
  return names;
}

export function validateRaw4DTrackProperties(
  propertyNames: readonly string[],
  totalFrames: number,
  comments: ReadonlyMap<string, string>,
  definition: Raw4DTrackDefinition,
): number {
  const names = new Set(propertyNames);
  const bankCount = raw4DBankCount(propertyNames, definition);
  if (bankCount === 0) {
    if (definition.bankRequired) throw new Error(`RAW4D is missing ${definition.prefix} properties.`);
    const missingBase = definition.baseProperties.find((name) => !names.has(name));
    if (missingBase) throw new Error(`RAW4D is missing ${definition.prefix} and fallback property ${missingBase}.`);
    return 0;
  }
  for (let bank = 0; bank < bankCount; bank += 1) {
    for (const component of definition.components) {
      const name = raw4DTrackPropertyName(definition, bank, component);
      if (!names.has(name)) throw new Error(`RAW4D is missing property ${name}.`);
    }
  }
  raw4DCanonicalKeyframes(totalFrames, raw4DTrackStride(comments, definition), bankCount);
  return bankCount;
}

// #WDD-gpt 2026-08-16 - 统一 Master PLY4 的 bank、末帧关键帧和旧文件回退规则，避免各读取器各自猜测。
export function validateRaw4DCanonicalStructure(
  propertyNames: readonly string[],
  totalFrames: number,
  comments: ReadonlyMap<string, string>,
): void {
  const names = new Set(propertyNames);
  if (names.size !== propertyNames.length) throw new Error('RAW4D contains duplicate vertex property names.');
  const missingBase = RAW4D_CANONICAL_BASE_PROPERTIES.find((name) => !names.has(name));
  if (missingBase) throw new Error(`RAW4D is missing canonical base property ${missingBase}.`);
  raw4DShPropertyNames(propertyNames);
  for (const definition of Object.values(RAW4D_TRACK_DEFINITIONS)) {
    validateRaw4DTrackProperties(propertyNames, totalFrames, comments, definition);
  }
}
