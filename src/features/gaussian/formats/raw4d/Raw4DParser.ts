import type {
  Raw4DAsset,
  Raw4DHeader,
  Raw4DParseOptions,
  Raw4DScalarArray,
  Raw4DScalarEncoding,
  Raw4DSource,
  Raw4DTrack,
} from './Raw4DTypes';
import { RAW4D_FLOAT16_DECODE_TABLE } from './Raw4DFloat16';
import {
  RAW4D_TRACK_DEFINITIONS,
  raw4DBankCount,
  raw4DCanonicalKeyframes,
  raw4DShPropertyNames,
  raw4DTrackPropertyName,
  raw4DTrackStride,
  validateRaw4DCanonicalStructure,
  type Raw4DTrackDefinition,
} from './Raw4DSchema';

const MAX_HEADER_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_ROWS = 8192;

const SCALAR_BYTES: Record<Raw4DScalarEncoding, number> = {
  float32: Float32Array.BYTES_PER_ELEMENT,
  float16: Uint16Array.BYTES_PER_ELEMENT,
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('RAW4D import was cancelled.', 'AbortError');
  }
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid RAW4D ${label}: ${value ?? 'missing'}.`);
  }
  return parsed;
}

function createTrack(
  header: Raw4DHeader,
  storages: ReadonlyMap<string, Raw4DScalarArray>,
  definition: Raw4DTrackDefinition,
): Raw4DTrack {
  const bankCount = raw4DBankCount(header.propertyNames, definition);
  if (bankCount === 0) {
    const values = definition.baseProperties.map((name) => {
      const storage = storages.get(name);
      if (!storage) throw new Error(`RAW4D is missing fallback property ${name}.`);
      return storage;
    });
    return { encoding: header.scalarEncoding, components: definition.components.length, keyframes: [0], values };
  }
  const keyframes = raw4DCanonicalKeyframes(
    header.totalFrames,
    raw4DTrackStride(header.comments, definition),
    bankCount,
  );
  const values: Raw4DScalarArray[] = [];
  for (let bank = 0; bank < bankCount; bank += 1) {
    for (const component of definition.components) {
      const name = raw4DTrackPropertyName(definition, bank, component);
      const storage = storages.get(name);
      if (!storage) {
        throw new Error(`RAW4D is missing property ${name}.`);
      }
      values.push(storage);
    }
  }
  return { encoding: header.scalarEncoding, components: definition.components.length, keyframes, values };
}

function calculateBounds(position: Raw4DTrack): Raw4DAsset['bounds'] {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let key = 0; key < position.keyframes.length; key += 1) {
    const offset = key * position.components;
    const x = position.values[offset];
    const y = position.values[offset + 1];
    const z = position.values[offset + 2];
    for (let index = 0; index < x.length; index += 1) {
      const positionX = headerlessValue(x, index, position.encoding);
      const positionY = headerlessValue(y, index, position.encoding);
      const positionZ = headerlessValue(z, index, position.encoding);
      minX = Math.min(minX, positionX);
      minY = Math.min(minY, positionY);
      minZ = Math.min(minZ, positionZ);
      maxX = Math.max(maxX, positionX);
      maxY = Math.max(maxY, positionY);
      maxZ = Math.max(maxZ, positionZ);
    }
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    throw new Error('RAW4D position banks contain invalid non-finite coordinates.');
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function headerlessValue(values: Raw4DScalarArray, index: number, encoding: Raw4DScalarEncoding): number {
  return encoding === 'float16'
    ? RAW4D_FLOAT16_DECODE_TABLE[(values as Uint16Array)[index]]
    : (values as Float32Array)[index];
}

function shBandsFromCount(count: number): number {
  const result = new Map([[0, 0], [9, 1], [24, 2], [45, 3]]).get(count);
  if (result === undefined) {
    throw new Error(`Unsupported RAW4D SH coefficient count: ${count}.`);
  }
  return result;
}

function requiredPropertyNames(header: Raw4DHeader): string[] {
  const names = new Set<string>(['lifetime_mu', 'lifetime_w']);
  for (const definition of Object.values(RAW4D_TRACK_DEFINITIONS)) {
    const bankCount = raw4DBankCount(header.propertyNames, definition);
    if (bankCount === 0) {
      definition.baseProperties.forEach((name) => names.add(name));
    } else {
      for (let bank = 0; bank < bankCount; bank += 1) {
        for (const component of definition.components) {
          names.add(raw4DTrackPropertyName(definition, bank, component));
        }
      }
    }
  }
  raw4DShPropertyNames(header.propertyNames).forEach((name) => names.add(name));
  return [...names];
}

interface Raw4DCanonicalValidationPlan {
  readonly aliases: readonly (readonly [number, number, string])[];
  readonly normals: readonly number[];
  readonly rotations: readonly (readonly number[])[];
  readonly opacity: readonly number[];
  readonly lifetimeMu: number;
  readonly lifetimeW: number;
}

function canonicalValidationPlan(header: Raw4DHeader): Raw4DCanonicalValidationPlan {
  const indices = new Map(header.propertyNames.map((name, index) => [name, index]));
  const requireIndex = (name: string): number => {
    const value = indices.get(name);
    if (value === undefined) throw new Error(`RAW4D is missing canonical property ${name}.`);
    return value;
  };
  const aliases: Array<readonly [number, number, string]> = [];
  for (const definition of [
    RAW4D_TRACK_DEFINITIONS.position,
    RAW4D_TRACK_DEFINITIONS.colorDc,
    RAW4D_TRACK_DEFINITIONS.scale,
    RAW4D_TRACK_DEFINITIONS.opacity,
  ]) {
    if (raw4DBankCount(header.propertyNames, definition) === 0) continue;
    for (let component = 0; component < definition.components.length; component += 1) {
      const baseName = definition.baseProperties[component];
      const bankName = raw4DTrackPropertyName(definition, 0, definition.components[component]);
      aliases.push([requireIndex(baseName), requireIndex(bankName), `${baseName} == ${bankName}`]);
    }
  }
  const rotation = RAW4D_TRACK_DEFINITIONS.rotation;
  const rotationBankCount = raw4DBankCount(header.propertyNames, rotation);
  const rotations = rotationBankCount > 0
    ? Array.from({ length: rotationBankCount }, (_, bank) => (
      rotation.components.map((component) => requireIndex(raw4DTrackPropertyName(rotation, bank, component)))
    ))
    : [rotation.baseProperties.map(requireIndex)];
  const opacity = RAW4D_TRACK_DEFINITIONS.opacity;
  const opacityBankCount = raw4DBankCount(header.propertyNames, opacity);
  return {
    aliases,
    normals: ['nx', 'ny', 'nz'].map(requireIndex),
    rotations,
    opacity: opacityBankCount > 0
      ? Array.from({ length: opacityBankCount }, (_, bank) => requireIndex(raw4DTrackPropertyName(opacity, bank, '')))
      : [requireIndex('opacity')],
    lifetimeMu: requireIndex('lifetime_mu'),
    lifetimeW: requireIndex('lifetime_w'),
  };
}

function validateCanonicalChunk(
  chunk: Float32Array | Uint16Array,
  header: Raw4DHeader,
  firstRow: number,
  rowCount: number,
  plan: Raw4DCanonicalValidationPlan,
): void {
  const encoded = header.scalarEncoding === 'float16'
    ? chunk as Uint16Array
    : new Uint32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
  const signMask = header.scalarEncoding === 'float16' ? 0x7fff : 0x7fffffff;
  for (let row = 0; row < rowCount; row += 1) {
    const offset = row * header.propertyNames.length;
    for (const [base, bank, label] of plan.aliases) {
      const baseValue = headerlessValue(chunk, offset + base, header.scalarEncoding);
      const bankValue = headerlessValue(chunk, offset + bank, header.scalarEncoding);
      const toleranceScale = Math.max(1, Math.abs(baseValue), Math.abs(bankValue));
      const tolerance = toleranceScale * (header.scalarEncoding === 'float16' ? 1e-3 : 1e-6);
      if (baseValue !== bankValue && Math.abs(baseValue - bankValue) > tolerance) {
        throw new Error(`RAW4D canonical snapshot mismatch at row ${firstRow + row}: ${label}.`);
      }
    }
    for (const normal of plan.normals) {
      if ((encoded[offset + normal] & signMask) !== 0) {
        throw new Error(`RAW4D normal placeholders must be zero at row ${firstRow + row}.`);
      }
    }
    for (const rotation of plan.rotations) {
      let normSquared = 0;
      for (const property of rotation) {
        const value = headerlessValue(chunk, offset + property, header.scalarEncoding);
        normSquared += value * value;
      }
      // #WDD-gpt 2026-08-16 - 旋转可非单位长度并在采样时归一化，但不能是零或非有限四元数。
      if (!Number.isFinite(normSquared) || normSquared <= 0) {
        throw new Error(`RAW4D rotation quaternion must be finite and non-zero at row ${firstRow + row}.`);
      }
    }
    for (const opacity of plan.opacity) {
      const value = headerlessValue(chunk, offset + opacity, header.scalarEncoding);
      // #WDD-gpt 2026-08-16 - 六段实数数据用 -Infinity 表示严格透明；只兼容该 logit，拒绝会传播到渲染器的 NaN/+Infinity。
      if (Number.isNaN(value) || value === Infinity) {
        throw new Error(`RAW4D opacity logit must be finite or -Infinity at row ${firstRow + row}.`);
      }
    }
    const lifetimeMu = headerlessValue(chunk, offset + plan.lifetimeMu, header.scalarEncoding);
    const lifetimeW = headerlessValue(chunk, offset + plan.lifetimeW, header.scalarEncoding);
    // #WDD-gpt 2026-08-18 - 兼容裁剪/SVD 流程产生的微小负 lifetime_w：它表示空生命周期并由健康检查单独报告，导入层只拒绝会污染运行时的非有限值且保持源位精确。
    if (!Number.isFinite(lifetimeMu) || !Number.isFinite(lifetimeW)) {
      throw new Error(`RAW4D lifetime must be finite at row ${firstRow + row}.`);
    }
  }
}

async function yieldToHost(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function readRaw4DHeader(source: Raw4DSource, signal?: AbortSignal): Promise<Raw4DHeader> {
  let bytesToRead = Math.min(source.size, 4096);
  let headerText = '';
  let dataOffset = -1;
  while (bytesToRead <= Math.min(source.size, MAX_HEADER_BYTES)) {
    throwIfAborted(signal);
    const bytes = new Uint8Array(await source.slice(0, bytesToRead).arrayBuffer());
    headerText = new TextDecoder('ascii').decode(bytes);
    const marker = /end_header\r?\n/.exec(headerText);
    if (marker) {
      dataOffset = marker.index + marker[0].length;
      headerText = headerText.slice(0, dataOffset);
      break;
    }
    if (bytesToRead === source.size || bytesToRead === MAX_HEADER_BYTES) {
      break;
    }
    bytesToRead = Math.min(source.size, MAX_HEADER_BYTES, bytesToRead * 2);
  }

  if (dataOffset < 0) {
    throw new Error('Invalid RAW4D file: end_header was not found.');
  }

  const lines = headerText.trim().split(/\r?\n/);
  if (lines[0] !== 'ply' || lines[1] !== 'format binary_little_endian 1.0') {
    throw new Error('RAW4D requires a binary_little_endian PLY 1.0 container.');
  }

  const comments = new Map<string, string>();
  const fp16PropertyNames = new Set<string>();
  const propertyNames: string[] = [];
  const propertyEncodings: Raw4DScalarEncoding[] = [];
  let vertexCount = 0;
  let vertexElementCount = 0;
  const otherElements: string[] = [];
  let inVertexElement = false;
  for (const line of lines.slice(2)) {
    const comment = /^comment\s+(\S+)\s+(.+)$/.exec(line);
    if (comment) {
      comments.set(comment[1], comment[2].trim());
      if (comment[1] === 'fp16_property') fp16PropertyNames.add(comment[2].trim());
      continue;
    }
    const element = /^element\s+(\S+)\s+(\d+)$/.exec(line);
    if (element) {
      inVertexElement = element[1] === 'vertex';
      if (inVertexElement) {
        vertexElementCount += 1;
        vertexCount = Number(element[2]);
      } else {
        otherElements.push(element[1]);
      }
      continue;
    }
    const property = /^property\s+(\S+)\s+(\S+)$/.exec(line);
    if (property && inVertexElement) {
      if (property[1] === 'float' || property[1] === 'float32') {
        propertyEncodings.push('float32');
      } else if (property[1] === 'ushort' || property[1] === 'uint16') {
        propertyEncodings.push('float16');
      } else {
        throw new Error(`Unsupported RAW4D property type ${property[1]} for ${property[2]}.`);
      }
      propertyNames.push(property[2]);
    }
  }

  if (vertexElementCount !== 1 || !Number.isInteger(vertexCount) || vertexCount <= 0 || propertyNames.length === 0) {
    throw new Error('RAW4D header does not contain a valid vertex element.');
  }
  if (otherElements.length > 0) {
    throw new Error(`RAW4D canonical PLY must contain only the vertex element; found ${otherElements[0]}.`);
  }
  const scalarEncoding = propertyEncodings[0];
  if (propertyEncodings.some((encoding) => encoding !== scalarEncoding)) {
    throw new Error('RAW4D requires one uniform scalar encoding for all vertex properties.');
  }
  if (scalarEncoding === 'float16') {
    if (comments.get('fp16_quantized') !== '1') {
      throw new Error('RAW4D ushort properties require comment fp16_quantized 1.');
    }
    const unknownMarker = [...fp16PropertyNames].find((name) => !propertyNames.includes(name));
    if (unknownMarker) {
      throw new Error(`RAW4D fp16_property marker references unknown property ${unknownMarker}.`);
    }
  }

  const totalFrames = parsePositiveInteger(comments.get('total_frames'), 'total_frames');
  validateRaw4DCanonicalStructure(propertyNames, totalFrames, comments);

  return {
    dataOffset,
    recordBytes: propertyNames.length * SCALAR_BYTES[scalarEncoding],
    vertexCount,
    totalFrames,
    scalarEncoding,
    propertyNames,
    comments,
  };
}

export async function parseRaw4D(source: Raw4DSource, options: Raw4DParseOptions = {}): Promise<Raw4DAsset> {
  options.onProgress?.({ ratio: 0, stage: 'header', message: '正在读取 RAW4D 头部' });
  const header = await readRaw4DHeader(source, options.signal);
  throwIfAborted(options.signal);

  const requiredBytes = header.dataOffset + header.vertexCount * header.recordBytes;
  if (source.size < requiredBytes) {
    throw new Error(`RAW4D data is truncated: expected ${requiredBytes} bytes, found ${source.size}.`);
  }
  if (source.size > requiredBytes) {
    throw new Error(`RAW4D canonical PLY has ${source.size - requiredBytes} unexpected trailing bytes.`);
  }

  const propertyIndices = new Map(header.propertyNames.map((name, index) => [name, index]));
  const validationPlan = canonicalValidationPlan(header);
  const requiredNames = requiredPropertyNames(header);
  const scalarLength = header.vertexCount * requiredNames.length;
  // #WDD-gpt 2026-08-16 - 所有 Canonical 属性共享一个 backing store，并按源位宽建立 SoA 视图，减少碎片且让 Worker 只移交一次所有权。
  const backingStorage = options.createStorage?.(scalarLength, header.scalarEncoding)
    ?? (header.scalarEncoding === 'float16'
      ? new Uint16Array(scalarLength)
      : new Float32Array(scalarLength));
  const correctStorage = header.scalarEncoding === 'float16'
    ? backingStorage instanceof Uint16Array
    : backingStorage instanceof Float32Array;
  if (!correctStorage || backingStorage.length !== scalarLength) {
    throw new Error(`RAW4D storage factory returned an invalid ${header.scalarEncoding} backing store.`);
  }
  const storages = new Map<string, Raw4DScalarArray>();
  const extraction: Array<{ sourceIndex: number; destination: Raw4DScalarArray }> = [];
  for (let property = 0; property < requiredNames.length; property += 1) {
    const name = requiredNames[property];
    const sourceIndex = propertyIndices.get(name);
    if (sourceIndex === undefined) {
      throw new Error(`RAW4D is missing required property ${name}.`);
    }
    const first = property * header.vertexCount;
    const destination = backingStorage.subarray(first, first + header.vertexCount) as Raw4DScalarArray;
    storages.set(name, destination);
    extraction.push({ sourceIndex, destination });
  }

  const chunkRows = Math.max(256, Math.floor(options.chunkRows ?? DEFAULT_CHUNK_ROWS));
  for (let firstRow = 0; firstRow < header.vertexCount; firstRow += chunkRows) {
    throwIfAborted(options.signal);
    const rowCount = Math.min(chunkRows, header.vertexCount - firstRow);
    const byteStart = header.dataOffset + firstRow * header.recordBytes;
    const byteEnd = byteStart + rowCount * header.recordBytes;
    const chunkBuffer = await source.slice(byteStart, byteEnd).arrayBuffer();
    // #WDD-gpt  2026-08-15 - 按 header 声明选择 float32 或 fp16 位模式，避免把 ushort 当整数坐标读取。
    const chunk = header.scalarEncoding === 'float16'
      ? new Uint16Array(chunkBuffer)
      : new Float32Array(chunkBuffer);
    validateCanonicalChunk(chunk, header, firstRow, rowCount, validationPlan);
    if (options.extractChunk) {
      await options.extractChunk({
        chunk,
        sourceEncoding: header.scalarEncoding,
        propertyCount: header.propertyNames.length,
        firstRow,
        rowCount,
        properties: extraction,
      });
    } else {
      for (const { sourceIndex, destination } of extraction) {
        let sourceOffset = sourceIndex;
        for (let row = 0; row < rowCount; row += 1) {
          destination[firstRow + row] = chunk[sourceOffset];
          sourceOffset += header.propertyNames.length;
        }
      }
    }
    const ratio = (firstRow + rowCount) / header.vertexCount;
    options.onProgress?.({
      ratio: 0.03 + ratio * 0.94,
      stage: 'data',
      message: `正在读取高斯数据 ${Math.round(ratio * 100)}%`,
    });
    await yieldToHost();
  }

  options.onProgress?.({ ratio: 0.98, stage: 'finalizing', message: '正在建立 4D 关键帧轨迹' });
  const position = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.position);
  const rotation = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.rotation);
  const colorDc = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.colorDc);
  const scale = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.scale);
  const opacity = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.opacity);
  const shRest = raw4DShPropertyNames(header.propertyNames).map((name) => storages.get(name)!);

  const asset: Raw4DAsset = {
    sourceName: options.sourceName ?? 'Untitled.raw4d',
    sourceEncoding: header.scalarEncoding,
    splatCount: header.vertexCount,
    totalFrames: header.totalFrames,
    shBands: shBandsFromCount(shRest.length),
    position,
    rotation,
    colorDc,
    scale,
    opacity,
    shRest,
    lifetimeMu: storages.get('lifetime_mu')!,
    lifetimeW: storages.get('lifetime_w')!,
    bounds: calculateBounds(position),
  };
  options.onProgress?.({ ratio: 1, stage: 'finalizing', message: 'RAW4D 解析完成' });
  return asset;
}

export async function canImportRaw4D(source: Raw4DSource): Promise<boolean> {
  try {
    const header = await readRaw4DHeader(source);
    return header.comments.has('total_frames') && raw4DBankCount(header.propertyNames, RAW4D_TRACK_DEFINITIONS.position) > 0;
  } catch {
    return false;
  }
}
