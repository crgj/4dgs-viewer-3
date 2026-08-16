import type { Raw4DAsset, Raw4DTrack } from '../raw4d/Raw4DTypes';
import type { GaussianAssetDecodeOptions, ImportedGaussianAsset } from './GaussianImportTypes';
import {
  abortIfRequested,
  calculateBounds,
  finalizeImportedAsset,
  SH_COEFFICIENTS_BY_BAND,
  staticTrack,
} from './GaussianImportUtils';

// #WDD-gpt 2026-08-16 - PLY 与 PLY4 直接解码为共享 canonical 轨道，不创建格式专属渲染资源。

type PlyScalarType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';

interface PlyProperty { readonly name: string; readonly type: PlyScalarType; readonly offset: number; }
interface PlyPropertyBank { readonly index: number; readonly names: readonly string[]; }
interface PlyHeader {
  readonly comments: readonly string[];
  readonly dataOffset: number;
  readonly format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  readonly properties: readonly PlyProperty[];
  readonly recordBytes: number;
  readonly vertexCount: number;
}

const TYPE_BYTES: Readonly<Record<PlyScalarType, number>> = {
  char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8,
};

// #WDD-gpt 2026-08-16 - 接受 viewer-2 与常见 PLY 工具写出的显式位宽类型别名。
const TYPE_ALIASES: Readonly<Record<string, PlyScalarType>> = {
  char: 'char', int8: 'char',
  uchar: 'uchar', uint8: 'uchar',
  short: 'short', int16: 'short',
  ushort: 'ushort', uint16: 'ushort',
  int: 'int', int32: 'int',
  uint: 'uint', uint32: 'uint',
  float: 'float', float32: 'float',
  double: 'double', float64: 'double',
};

function parseHeader(bytes: Uint8Array): PlyHeader {
  const marker = new TextEncoder().encode('end_header');
  let markerOffset = -1;
  outer: for (let index = 0; index <= Math.min(bytes.length - marker.length, 1024 * 1024); index += 1) {
    for (let part = 0; part < marker.length; part += 1) {
      if (bytes[index + part] !== marker[part]) continue outer;
    }
    markerOffset = index;
    break;
  }
  if (markerOffset < 0) throw new Error('PLY header exceeds 1 MB or misses end_header.');
  let dataOffset = markerOffset + marker.length;
  while (dataOffset < bytes.length && (bytes[dataOffset] === 10 || bytes[dataOffset] === 13)) dataOffset += 1;
  const lines = new TextDecoder().decode(bytes.subarray(0, markerOffset)).split(/\r?\n/);
  if (lines[0]?.trim() !== 'ply') throw new Error('Invalid PLY signature.');
  const formatToken = lines.find((line) => line.trim().startsWith('format '))?.trim().split(/\s+/)[1];
  if (formatToken !== 'ascii' && formatToken !== 'binary_little_endian' && formatToken !== 'binary_big_endian') {
    throw new Error(`Unsupported PLY format: ${formatToken ?? 'missing'}.`);
  }
  let vertexCount = 0;
  let inVertex = false;
  let recordBytes = 0;
  const properties: PlyProperty[] = [];
  const comments: string[] = [];
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] === 'comment' && tokens.length >= 2) {
      comments.push(tokens.slice(1).join(' '));
    } else if (tokens[0] === 'element') {
      inVertex = tokens[1] === 'vertex';
      if (inVertex) vertexCount = Number(tokens[2]);
    } else if (tokens[0] === 'property' && inVertex) {
      if (tokens[1] === 'list') throw new Error('List properties inside PLY vertex elements are not supported.');
      const type = TYPE_ALIASES[tokens[1]?.toLowerCase()];
      if (!type) throw new Error(`Unsupported PLY scalar type: ${tokens[1]}.`);
      if (!tokens[2]) throw new Error('PLY vertex property is missing its name.');
      properties.push({ name: tokens[2], type, offset: recordBytes });
      recordBytes += TYPE_BYTES[type];
    }
  }
  if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) throw new Error('PLY has no valid vertex element.');
  return { comments, dataOffset, format: formatToken, properties, recordBytes, vertexCount };
}

function readBinaryScalar(view: DataView, offset: number, type: PlyScalarType, littleEndian: boolean): number {
  switch (type) {
    case 'char': return view.getInt8(offset);
    case 'uchar': return view.getUint8(offset);
    case 'short': return view.getInt16(offset, littleEndian);
    case 'ushort': return view.getUint16(offset, littleEndian);
    case 'int': return view.getInt32(offset, littleEndian);
    case 'uint': return view.getUint32(offset, littleEndian);
    case 'float': return view.getFloat32(offset, littleEndian);
    case 'double': return view.getFloat64(offset, littleEndian);
  }
}

function commentValue(comments: readonly string[], key: string): string | undefined {
  for (const comment of comments) {
    const tokens = comment.trim().split(/\s+/);
    const index = tokens.indexOf(key);
    if (index >= 0 && tokens[index + 1] !== undefined) return tokens[index + 1];
    const assignment = tokens.find((token) => token.startsWith(`${key}=`));
    if (assignment) return assignment.slice(key.length + 1);
  }
  return undefined;
}

function commentNumber(comments: readonly string[], key: string, fallback: number): number {
  const value = Number(commentValue(comments, key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function inferShBands(restCount: number): 0 | 1 | 2 | 3 {
  return restCount >= 45 ? 3 : restCount >= 24 ? 2 : restCount >= 9 ? 1 : 0;
}

function propertyBanks(
  properties: readonly PlyProperty[], prefix: string, components: readonly string[],
): PlyPropertyBank[] {
  const names = new Set(properties.map((property) => property.name));
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedPrefix}_bank_(\\d+)_`);
  const indices = new Set<number>();
  for (const name of names) {
    const match = name.match(pattern);
    if (match) indices.add(Number(match[1]));
  }
  return [...indices].sort((left, right) => left - right).map((index) => {
    const bankNames = components.map((component) => `${prefix}_bank_${index}_${component}`);
    const missing = bankNames.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`PLY4 bank ${prefix}[${index}] is incomplete; missing ${missing.join(', ')}.`);
    }
    return { index, names: bankNames };
  });
}

function makeTrack(
  map: ReadonlyMap<string, Float32Array>,
  banks: readonly PlyPropertyBank[],
  baseNames: readonly string[],
  stride: number,
  fallback?: readonly number[],
): Raw4DTrack {
  const groups = banks.length > 0 ? banks.map((bank) => bank.names) : [baseNames];
  for (const names of groups) {
    const missing = names.filter((name) => !map.has(name));
    if (missing.length > 0) {
      if (banks.length === 0 && fallback?.length === baseNames.length) {
        const count = map.values().next().value?.length ?? 0;
        return staticTrack(baseNames.length, fallback.map((value) => new Float32Array(count).fill(value)));
      }
      throw new Error(`PLY is missing required property "${missing[0]}".`);
    }
  }
  return {
    encoding: 'float32',
    components: baseNames.length,
    keyframes: banks.length > 0 ? banks.map((bank) => bank.index * stride) : [0],
    values: groups.flatMap((names) => names.map((name) => map.get(name)!)),
  };
}

function normalizeRotationTrack(track: Raw4DTrack, componentOrder: string | undefined): Raw4DTrack {
  if (componentOrder?.toLowerCase() !== 'xyzw') return track;
  const values: Float32Array[] = [];
  for (let index = 0; index < track.values.length; index += 4) {
    values.push(
      track.values[index + 3] as Float32Array,
      track.values[index] as Float32Array,
      track.values[index + 1] as Float32Array,
      track.values[index + 2] as Float32Array,
    );
  }
  return { ...track, values };
}

export async function decodePlyGaussian(
  file: File,
  options: GaussianAssetDecodeOptions,
): Promise<ImportedGaussianAsset> {
  abortIfRequested(options.signal);
  options.onProgress?.({ ratio: 0.02, stage: 'header', message: '正在读取 PLY / PLY4 头部' });
  const buffer = await file.arrayBuffer();
  abortIfRequested(options.signal);
  const bytes = new Uint8Array(buffer);
  const header = parseHeader(bytes);
  const estimatedBytes = header.vertexCount * Math.max(14, header.properties.length) * 4;
  if (estimatedBytes > options.cpuBudgetBytes) {
    throw new Error(`PLY 解码预计需要 ${(estimatedBytes / 1e9).toFixed(2)} GB，超过统一内存预算。`);
  }
  const values = new Map<string, Float32Array>();
  for (const property of header.properties) values.set(property.name, new Float32Array(header.vertexCount));
  options.onProgress?.({ ratio: 0.12, stage: 'data', message: '正在解码 Gaussian 属性' });
  if (header.format === 'ascii') {
    const tokens = new TextDecoder().decode(bytes.subarray(header.dataOffset)).trim().split(/\s+/);
    const expected = header.vertexCount * header.properties.length;
    if (tokens.length < expected) throw new Error('ASCII PLY vertex data is truncated.');
    for (let row = 0; row < header.vertexCount; row += 1) {
      for (let column = 0; column < header.properties.length; column += 1) {
        values.get(header.properties[column].name)![row] = Number(tokens[row * header.properties.length + column]);
      }
      if ((row & 0x3fff) === 0) abortIfRequested(options.signal);
    }
  } else {
    const expectedEnd = header.dataOffset + header.recordBytes * header.vertexCount;
    if (expectedEnd > buffer.byteLength) throw new Error('Binary PLY vertex data is truncated.');
    const view = new DataView(buffer);
    const littleEndian = header.format === 'binary_little_endian';
    for (let row = 0; row < header.vertexCount; row += 1) {
      const base = header.dataOffset + row * header.recordBytes;
      for (const property of header.properties) {
        values.get(property.name)![row] = readBinaryScalar(view, base + property.offset, property.type, littleEndian);
      }
      if ((row & 0x3fff) === 0) abortIfRequested(options.signal);
    }
  }
  options.onProgress?.({ ratio: 0.82, stage: 'canonical', message: '正在建立统一 Gaussian 内存布局' });
  const propertyNames = header.properties.map((property) => property.name);
  const positionBanks = propertyBanks(header.properties, 'xyz', ['x', 'y', 'z']);
  const rotationBanks = propertyBanks(header.properties, 'rot', ['w', 'x', 'y', 'z']);
  const dcBanks = propertyBanks(header.properties, 'f_dc', ['0', '1', '2']);
  const totalFrames = Math.max(1, Math.round(commentNumber(header.comments, 'total_frames', 1)));
  const position = makeTrack(values, positionBanks, ['x', 'y', 'z'], commentNumber(header.comments, 'xyz_bank_keyframe_stride', 1));
  const rotationBase = propertyNames.includes('rot_0')
    ? ['rot_0', 'rot_1', 'rot_2', 'rot_3']
    : ['qw', 'qx', 'qy', 'qz'];
  // #WDD-gpt 2026-08-16 - Master PLY4 的旋转 bank 为可选项；缺省时按 viewer-2 约定使用单位四元数。
  const rotation = normalizeRotationTrack(
    makeTrack(
      values,
      rotationBanks,
      rotationBase,
      commentNumber(header.comments, 'rot_bank_keyframe_stride', 1),
      [1, 0, 0, 0],
    ),
    commentValue(header.comments, 'rot_bank_component_order'),
  );
  const colorDc = makeTrack(values, dcBanks, ['f_dc_0', 'f_dc_1', 'f_dc_2'], commentNumber(header.comments, 'features_dc_bank_keyframe_stride', 1));
  const scale = makeTrack(values, [], ['scale_0', 'scale_1', 'scale_2'], 1);
  const opacity = makeTrack(values, [], ['opacity'], 1);
  const restNames = propertyNames.filter((name) => /^f_rest_\d+$/.test(name)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  const shBands = inferShBands(restNames.length);
  const shRest = restNames.slice(0, SH_COEFFICIENTS_BY_BAND[shBands] * 3).map((name) => values.get(name)!);
  const lifetimeMu = values.get('lifetime_mu') ?? new Float32Array(header.vertexCount).fill((totalFrames - 1) / 2);
  const lifetimeW = values.get('lifetime_w') ?? new Float32Array(header.vertexCount).fill(Math.max(1, totalFrames));
  const asset: Raw4DAsset = {
    sourceName: file.name,
    sourceEncoding: 'float32',
    splatCount: header.vertexCount,
    totalFrames,
    shBands,
    position,
    rotation,
    colorDc,
    scale,
    opacity,
    shRest,
    lifetimeMu,
    lifetimeW,
    bounds: calculateBounds(position.values[0], position.values[1], position.values[2]),
  };
  const format = /\.ply4$/i.test(file.name) || positionBanks.length > 1 || totalFrames > 1 ? 'PLY4' : 'PLY';
  options.onProgress?.({ ratio: 1, stage: 'finalizing', message: `${format} 解码完成` });
  return finalizeImportedAsset(file, format, asset, options);
}
