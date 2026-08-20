import type {
  Raw4DAsset,
  Raw4DElementHeader,
  Raw4DHeader,
  Raw4DParseOptions,
  Raw4DScalarArray,
  Raw4DScalarEncoding,
  Raw4DSource,
  Raw4DTemporalPointGroup,
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

type Raw4DValidationHeader = Pick<Raw4DHeader, 'propertyNames' | 'scalarEncoding'>;

function canonicalValidationPlan(header: Raw4DValidationHeader): Raw4DCanonicalValidationPlan {
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
  header: Raw4DValidationHeader,
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
  const fp16PropertyMarkers: string[] = [];
  interface ParsedElement {
    readonly name: string;
    readonly count: number;
    readonly propertyNames: string[];
    readonly propertyEncodings: Raw4DScalarEncoding[];
  }
  const parsedElements: ParsedElement[] = [];
  let currentElement: ParsedElement | null = null;
  for (const line of lines.slice(2)) {
    const comment = /^comment\s+(\S+)\s+(.+)$/.exec(line);
    if (comment) {
      comments.set(comment[1], comment[2].trim());
      if (comment[1] === 'fp16_property') fp16PropertyMarkers.push(comment[2].trim());
      continue;
    }
    const element = /^element\s+(\S+)\s+(\d+)$/.exec(line);
    if (element) {
      currentElement = {
        name: element[1],
        count: Number(element[2]),
        propertyNames: [],
        propertyEncodings: [],
      };
      parsedElements.push(currentElement);
      continue;
    }
    const property = /^property\s+(\S+)\s+(\S+)$/.exec(line);
    if (property && currentElement) {
      if (property[1] === 'float' || property[1] === 'float32') {
        currentElement.propertyEncodings.push('float32');
      } else if (property[1] === 'ushort' || property[1] === 'uint16') {
        currentElement.propertyEncodings.push('float16');
      } else {
        throw new Error(`Unsupported RAW4D property type ${property[1]} for ${property[2]}.`);
      }
      currentElement.propertyNames.push(property[2]);
      continue;
    }
    if (line.startsWith('property ')) {
      throw new Error(`Unsupported RAW4D property declaration: ${line}.`);
    }
  }

  const vertexElements = parsedElements.filter((element) => element.name === 'vertex');
  const staticElements = parsedElements.filter((element) => element.name === 'vertex_static');
  const unknownElement = parsedElements.find((element) => element.name !== 'vertex' && element.name !== 'vertex_static');
  if (unknownElement) {
    throw new Error(`RAW4D canonical PLY supports only vertex and vertex_static elements; found ${unknownElement.name}.`);
  }
  if (vertexElements.length !== 1 || vertexElements[0].propertyNames.length === 0) {
    throw new Error('RAW4D header does not contain a valid vertex element.');
  }
  if (staticElements.length > 1 || staticElements.some((element) => element.propertyNames.length === 0)) {
    throw new Error('RAW4D header contains an invalid vertex_static element.');
  }
  const allEncodings = parsedElements.flatMap((element) => element.propertyEncodings);
  const scalarEncoding = allEncodings[0];
  if (!scalarEncoding || allEncodings.some((encoding) => encoding !== scalarEncoding)) {
    throw new Error('RAW4D requires one uniform scalar encoding for all point properties.');
  }
  if (scalarEncoding === 'float16') {
    if (comments.get('fp16_quantized') !== '1') {
      throw new Error('RAW4D ushort properties require comment fp16_quantized 1.');
    }
    for (const marker of fp16PropertyMarkers) {
      const separator = marker.indexOf(':');
      const elementName = separator >= 0 ? marker.slice(0, separator) : 'vertex';
      const propertyName = separator >= 0 ? marker.slice(separator + 1) : marker;
      const element = parsedElements.find((candidate) => candidate.name === elementName);
      if (!element?.propertyNames.includes(propertyName)) {
        throw new Error(`RAW4D fp16_property marker references unknown property ${marker}.`);
      }
    }
  }

  const totalFrames = parsePositiveInteger(comments.get('total_frames'), 'total_frames');
  const dynamicElement = vertexElements[0];
  const propertyNames = dynamicElement.propertyNames;
  validateRaw4DCanonicalStructure(propertyNames, totalFrames, comments);

  const staticElement = staticElements[0];
  if (staticElement) {
    const names = new Set(staticElement.propertyNames);
    if (names.size !== staticElement.propertyNames.length) {
      throw new Error('RAW4D vertex_static contains duplicate property names.');
    }
    const requiredStatic = [
      ...RAW4D_TRACK_DEFINITIONS.position.baseProperties,
      ...RAW4D_TRACK_DEFINITIONS.rotation.baseProperties,
      ...RAW4D_TRACK_DEFINITIONS.colorDc.baseProperties,
      ...RAW4D_TRACK_DEFINITIONS.scale.baseProperties,
      ...RAW4D_TRACK_DEFINITIONS.opacity.baseProperties,
      'nx', 'ny', 'nz', 'lifetime_mu', 'lifetime_w',
    ];
    const missing = requiredStatic.find((name) => !names.has(name));
    if (missing) throw new Error(`RAW4D vertex_static is missing property ${missing}.`);
    const unexpectedBank = staticElement.propertyNames.find((name) => /_bank_\d+/.test(name));
    if (unexpectedBank) throw new Error(`RAW4D vertex_static must not contain bank property ${unexpectedBank}.`);
    const dynamicSh = raw4DShPropertyNames(propertyNames);
    const staticSh = raw4DShPropertyNames(staticElement.propertyNames);
    if (dynamicSh.length !== staticSh.length) {
      throw new Error(`RAW4D vertex_static SH coefficient count mismatch: ${staticSh.length}/${dynamicSh.length}.`);
    }
  }

  let elementDataOffset = dataOffset;
  const elements: Raw4DElementHeader[] = parsedElements.map((element) => {
    const recordBytes = element.propertyNames.length * SCALAR_BYTES[scalarEncoding];
    const result: Raw4DElementHeader = {
      name: element.name as Raw4DElementHeader['name'],
      dataOffset: elementDataOffset,
      recordBytes,
      count: element.count,
      scalarEncoding,
      propertyNames: element.propertyNames,
    };
    elementDataOffset += element.count * recordBytes;
    return result;
  });
  const dynamicHeader = elements.find((element) => element.name === 'vertex')!;
  const pointCount = elements.reduce((sum, element) => sum + element.count, 0);
  if (pointCount <= 0) throw new Error('RAW4D file does not contain any Gaussian points.');

  return {
    dataOffset,
    recordBytes: dynamicHeader.recordBytes,
    vertexCount: dynamicHeader.count,
    totalFrames,
    scalarEncoding,
    propertyNames,
    comments,
    pointCount,
    payloadBytes: elementDataOffset - dataOffset,
    elements,
  };
}

function staticSourcePropertyName(name: string): string {
  const position = /^xyz_bank_\d+_([xyz])$/.exec(name);
  if (position) return position[1];
  const rotation = /^rot_bank_\d+_([wxyz])$/.exec(name);
  if (rotation) return `rot_${['w', 'x', 'y', 'z'].indexOf(rotation[1])}`;
  const colorDc = /^f_dc_bank_\d+_(\d+)$/.exec(name);
  if (colorDc) return `f_dc_${colorDc[1]}`;
  const scale = /^scale_bank_\d+_(\d+)$/.exec(name);
  if (scale) return `scale_${scale[1]}`;
  if (/^opacity_bank_\d+$/.test(name)) return 'opacity';
  return name;
}

function elementExtraction(
  element: Raw4DElementHeader,
  requiredNames: readonly string[],
  storages: ReadonlyMap<string, Raw4DScalarArray>,
): Array<{ sourceIndex: number; destination: Raw4DScalarArray }> {
  const propertyIndices = new Map(element.propertyNames.map((name, index) => [name, index]));
  return requiredNames.map((name) => {
    const sourceName = element.name === 'vertex_static' ? staticSourcePropertyName(name) : name;
    const sourceIndex = propertyIndices.get(sourceName);
    if (sourceIndex === undefined) {
      throw new Error(`RAW4D ${element.name} is missing required property ${sourceName}.`);
    }
    return { sourceIndex, destination: storages.get(name)! };
  });
}

export async function parseRaw4D(source: Raw4DSource, options: Raw4DParseOptions = {}): Promise<Raw4DAsset> {
  options.onProgress?.({ ratio: 0, stage: 'header', message: '正在读取 RAW4D 头部' });
  const header = await readRaw4DHeader(source, options.signal);
  throwIfAborted(options.signal);

  const requiredBytes = header.dataOffset + header.payloadBytes;
  if (source.size < requiredBytes) {
    throw new Error(`RAW4D data is truncated: expected ${requiredBytes} bytes, found ${source.size}.`);
  }
  if (source.size > requiredBytes) {
    throw new Error(`RAW4D canonical PLY has ${source.size - requiredBytes} unexpected trailing bytes.`);
  }

  const requiredNames = requiredPropertyNames(header);
  const scalarLength = header.pointCount * requiredNames.length;
  // #WDD-gpt 2026-08-19 - 文件 element 只负责输入布局；进入 Canonical RAM 时统一为显式 K=1/K=2/K>2 轨迹，静态点广播不改变稳定 ID。
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
  for (let property = 0; property < requiredNames.length; property += 1) {
    const first = property * header.pointCount;
    storages.set(
      requiredNames[property],
      backingStorage.subarray(first, first + header.pointCount) as Raw4DScalarArray,
    );
  }

  const dynamicElement = header.elements.find((element) => element.name === 'vertex')!;
  const staticElement = header.elements.find((element) => element.name === 'vertex_static');
  const orderedElements = staticElement ? [dynamicElement, staticElement] : [dynamicElement];
  const chunkRows = Math.max(256, Math.floor(options.chunkRows ?? DEFAULT_CHUNK_ROWS));
  let completedRows = 0;
  for (const element of orderedElements) {
    const pointOffset = element.name === 'vertex_static' ? dynamicElement.count : 0;
    const validationPlan = canonicalValidationPlan(element);
    const extraction = elementExtraction(element, requiredNames, storages);
    for (let firstRow = 0; firstRow < element.count; firstRow += chunkRows) {
      throwIfAborted(options.signal);
      const rowCount = Math.min(chunkRows, element.count - firstRow);
      const byteStart = element.dataOffset + firstRow * element.recordBytes;
      const byteEnd = byteStart + rowCount * element.recordBytes;
      const chunkBuffer = await source.slice(byteStart, byteEnd).arrayBuffer();
      const chunk = header.scalarEncoding === 'float16'
        ? new Uint16Array(chunkBuffer)
        : new Float32Array(chunkBuffer);
      const destinationFirstRow = pointOffset + firstRow;
      validateCanonicalChunk(chunk, element, destinationFirstRow, rowCount, validationPlan);
      if (options.extractChunk) {
        await options.extractChunk({
          chunk,
          sourceEncoding: header.scalarEncoding,
          propertyCount: element.propertyNames.length,
          firstRow: destinationFirstRow,
          rowCount,
          properties: extraction,
        });
      } else {
        for (const { sourceIndex, destination } of extraction) {
          let sourceOffset = sourceIndex;
          for (let row = 0; row < rowCount; row += 1) {
            destination[destinationFirstRow + row] = chunk[sourceOffset];
            sourceOffset += element.propertyNames.length;
          }
        }
      }
      completedRows += rowCount;
      const ratio = completedRows / header.pointCount;
      options.onProgress?.({
        ratio: 0.03 + ratio * 0.94,
        stage: 'data',
        message: `正在读取高斯数据 ${Math.round(ratio * 100)}%`,
      });
      await yieldToHost();
    }
  }

  options.onProgress?.({ ratio: 0.98, stage: 'finalizing', message: '正在建立统一时间轨迹' });
  const position = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.position);
  const rotation = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.rotation);
  const colorDc = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.colorDc);
  const scale = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.scale);
  const opacity = createTrack(header, storages, RAW4D_TRACK_DEFINITIONS.opacity);
  const shRest = raw4DShPropertyNames(header.propertyNames).map((name) => storages.get(name)!);
  const dynamicKeyframes = {
    position: position.keyframes,
    rotation: rotation.keyframes,
    colorDc: colorDc.keyframes,
    scale: scale.keyframes,
    opacity: opacity.keyframes,
  } as const;
  const pointGroups: Raw4DTemporalPointGroup[] = [{
    id: 'dynamic',
    firstPoint: 0,
    pointCount: dynamicElement.count,
    sourceElement: 'vertex' as const,
    trackKeyframes: dynamicKeyframes,
  }];
  if (staticElement?.count) {
    const constantEndpoints = header.totalFrames > 1 ? [0, header.totalFrames - 1] : [0];
    pointGroups.push({
      id: 'static',
      firstPoint: dynamicElement.count,
      pointCount: staticElement.count,
      sourceElement: 'vertex_static',
      // #WDD-gpt 2026-08-19 - 静态点在统一时间语义中是首尾值严格相等的线性 K=2 轨迹；源数组仍只读一次并向现有 bank 视图广播。
      trackKeyframes: {
        position: constantEndpoints,
        rotation: constantEndpoints,
        colorDc: constantEndpoints,
        scale: constantEndpoints,
        opacity: constantEndpoints,
      },
    });
  }

  const asset: Raw4DAsset = {
    sourceName: options.sourceName ?? 'Untitled.raw4d',
    sourceEncoding: header.scalarEncoding,
    splatCount: header.pointCount,
    totalFrames: header.totalFrames,
    frameRate: Number.isFinite(Number(header.comments.get('frame_rate')))
      ? Number(header.comments.get('frame_rate')) : undefined,
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
    positionTiming: header.comments.get('position_timing') === 'per-point-lifetime-endpoints'
      ? 'per-point-lifetime-endpoints' : undefined,
    opacityTiming: header.comments.get('opacity_timing') === 'baked' ? 'baked' : undefined,
    temporalLayout: {
      schemaVersion: 1,
      interpolation: { position: 'linear', rotation: 'slerp', colorDc: 'linear', scale: 'linear', opacity: 'linear' },
      pointGroups,
    },
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
