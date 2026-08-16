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

const MAX_HEADER_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_ROWS = 8192;

const SCALAR_BYTES: Record<Raw4DScalarEncoding, number> = {
  float32: Float32Array.BYTES_PER_ELEMENT,
  float16: Uint16Array.BYTES_PER_ELEMENT,
};

interface TrackDefinition {
  prefix: string;
  components: readonly string[];
  strideComment: string;
}

const TRACK_DEFINITIONS: Record<'position' | 'rotation' | 'colorDc' | 'scale' | 'opacity', TrackDefinition> = {
  position: {
    prefix: 'xyz_bank',
    components: ['x', 'y', 'z'],
    strideComment: 'xyz_bank_keyframe_stride',
  },
  rotation: {
    prefix: 'rot_bank',
    components: ['w', 'x', 'y', 'z'],
    strideComment: 'rot_bank_keyframe_stride',
  },
  colorDc: {
    prefix: 'f_dc_bank',
    components: ['0', '1', '2'],
    strideComment: 'features_dc_bank_keyframe_stride',
  },
  scale: {
    prefix: 'scale_bank',
    components: ['0', '1', '2'],
    strideComment: 'scaling_bank_keyframe_stride',
  },
  opacity: {
    prefix: 'opacity_bank',
    components: [''],
    strideComment: 'opacity_bank_keyframe_stride',
  },
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

function propertyName(definition: TrackDefinition, bank: number, component: string): string {
  return component ? `${definition.prefix}_${bank}_${component}` : `${definition.prefix}_${bank}`;
}

function findBankCount(propertyNames: readonly string[], definition: TrackDefinition): number {
  let maximum = -1;
  const expression = new RegExp(`^${definition.prefix}_(\\d+)(?:_|$)`);
  for (const name of propertyNames) {
    const match = expression.exec(name);
    if (match) {
      maximum = Math.max(maximum, Number(match[1]));
    }
  }
  return maximum + 1;
}

function createKeyframes(totalFrames: number, stride: number, count: number): number[] {
  const result: number[] = [];
  for (let frame = 0; frame < totalFrames; frame += stride) {
    result.push(frame);
  }
  if (result.at(-1) !== totalFrames - 1) {
    result.push(totalFrames - 1);
  }
  if (result.length !== count) {
    throw new Error(`RAW4D keyframe bank count mismatch: expected ${result.length}, found ${count}.`);
  }
  return result;
}

function createTrack(
  header: Raw4DHeader,
  storages: ReadonlyMap<string, Raw4DScalarArray>,
  definition: TrackDefinition,
): Raw4DTrack {
  const bankCount = findBankCount(header.propertyNames, definition);
  if (bankCount === 0) {
    throw new Error(`RAW4D is missing ${definition.prefix} properties.`);
  }
  const stride = parsePositiveInteger(header.comments.get(definition.strideComment), definition.strideComment);
  const keyframes = createKeyframes(header.totalFrames, stride, bankCount);
  const values: Raw4DScalarArray[] = [];
  for (let bank = 0; bank < bankCount; bank += 1) {
    for (const component of definition.components) {
      const name = propertyName(definition, bank, component);
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
  for (const definition of Object.values(TRACK_DEFINITIONS)) {
    const bankCount = findBankCount(header.propertyNames, definition);
    for (let bank = 0; bank < bankCount; bank += 1) {
      for (const component of definition.components) {
        names.add(propertyName(definition, bank, component));
      }
    }
  }
  for (const name of header.propertyNames) {
    if (/^f_rest_\d+$/.test(name)) {
      names.add(name);
    }
  }
  return [...names];
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
        vertexCount = Number(element[2]);
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

  if (!Number.isInteger(vertexCount) || vertexCount <= 0 || propertyNames.length === 0) {
    throw new Error('RAW4D header does not contain a valid vertex element.');
  }
  const scalarEncoding = propertyEncodings[0];
  if (propertyEncodings.some((encoding) => encoding !== scalarEncoding)) {
    throw new Error('RAW4D requires one uniform scalar encoding for all vertex properties.');
  }
  if (scalarEncoding === 'float16') {
    if (comments.get('fp16_quantized') !== '1') {
      throw new Error('RAW4D ushort properties require comment fp16_quantized 1.');
    }
    const unmarkedProperty = propertyNames.find((name) => !fp16PropertyNames.has(name));
    if (unmarkedProperty) {
      throw new Error(`RAW4D ushort property ${unmarkedProperty} is not marked as fp16_property.`);
    }
  }

  return {
    dataOffset,
    recordBytes: propertyNames.length * SCALAR_BYTES[scalarEncoding],
    vertexCount,
    totalFrames: parsePositiveInteger(comments.get('total_frames'), 'total_frames'),
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

  const propertyIndices = new Map(header.propertyNames.map((name, index) => [name, index]));
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
  const position = createTrack(header, storages, TRACK_DEFINITIONS.position);
  const rotation = createTrack(header, storages, TRACK_DEFINITIONS.rotation);
  const colorDc = createTrack(header, storages, TRACK_DEFINITIONS.colorDc);
  const scale = createTrack(header, storages, TRACK_DEFINITIONS.scale);
  const opacity = createTrack(header, storages, TRACK_DEFINITIONS.opacity);
  const shRest = header.propertyNames
    .filter((name) => /^f_rest_\d+$/.test(name))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))
    .map((name) => storages.get(name)!);

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
    return header.comments.has('total_frames') && findBankCount(header.propertyNames, TRACK_DEFINITIONS.position) > 0;
  } catch {
    return false;
  }
}
