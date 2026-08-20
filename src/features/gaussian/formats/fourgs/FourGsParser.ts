import { calculateBounds } from '../import/GaussianImportUtils';
import type {
  Raw4DAsset,
  Raw4DParseOptions,
  Raw4DScalarArray,
  Raw4DSource,
  Raw4DTrack,
} from '../raw4d/Raw4DTypes';

// #WDD-gpt 2026-08-20 - EasyTimeGS++ 单文件 4GS v2/v3 在读取边界转换为现有 Canonical RAM，不建立第二套渲染数据。

export interface FourGsHeader {
  readonly version: 2 | 3;
  readonly dataOffset: number;
  readonly vertexCount: number;
  readonly recordBytes: number;
  readonly propertyNames: readonly string[];
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly frameCount: number;
  readonly shBands: 0 | 1 | 2 | 3;
  readonly opacityThreshold: number;
  readonly frameRate: number;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

const HEADER_LIMIT = 1024 * 1024;
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
const HALF_MAX = 65_504;
const FOUR_GS_V3_FOOTER_BYTES = 20;
const FOUR_GS_V3_MAGIC = 'ET4GSM03';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = new TextEncoder().encode('end_header');
  outer: for (let index = 0; index <= bytes.length - marker.length; index += 1) {
    for (let part = 0; part < marker.length; part += 1) {
      if (bytes[index + part] !== marker[part]) continue outer;
    }
    let offset = index + marker.length;
    while (offset < bytes.length && (bytes[offset] === 10 || bytes[offset] === 13)) offset += 1;
    return offset;
  }
  throw new Error('4GS 文件头超过 1 MB 或缺少 end_header。');
}

function shBands(restCount: number): 0 | 1 | 2 | 3 {
  if (restCount === 0) return 0;
  if (restCount === 9) return 1;
  if (restCount === 24) return 2;
  if (restCount === 45) return 3;
  throw new Error(`4GS SH 属性数量 ${restCount} 不对应 SH0/SH1/SH2/SH3。`);
}

export async function readFourGsHeader(source: Raw4DSource): Promise<FourGsHeader> {
  const bytes = new Uint8Array(await source.slice(0, Math.min(source.size, HEADER_LIMIT)).arrayBuffer());
  const dataOffset = findHeaderEnd(bytes);
  const lines = new TextDecoder('ascii').decode(bytes.subarray(0, dataOffset)).split(/\r?\n/);
  if (lines[0]?.trim() !== 'ply') throw new Error('4GS 文件签名无效。');
  if (!lines.some((line) => line.trim() === 'format binary_little_endian 1.0')) {
    throw new Error('4GS 只支持 binary_little_endian 1.0。');
  }
  const versionValue = Number(lines.find((line) => /^comment\s+easytimegspp-4dgs\s+version\s+/i.test(line.trim()))
    ?.trim().split(/\s+/).at(-1));
  if (versionValue !== 2 && versionValue !== 3) throw new Error(`仅支持 EasyTimeGS++ 4GS v2/v3，当前版本为 ${versionValue || '未知'}。`);
  const version = versionValue as 2 | 3;
  const time = lines.find((line) => /^comment\s+normalized_time_frames\s+/i.test(line.trim()))
    ?.trim().split(/\s+/).slice(-3).map(Number);
  if (!time || time.length !== 3 || time.some((value) => !Number.isSafeInteger(value))) {
    throw new Error('一体 4GS 缺少 normalized_time_frames 时间轴。');
  }
  const [firstFrame, lastFrame, frameCount] = time;
  if (frameCount <= 0 || lastFrame < firstFrame || lastFrame - firstFrame + 1 !== frameCount) {
    throw new Error('一体 4GS 当前只支持文件头可完整恢复的连续源帧。');
  }
  let vertexCount = 0;
  let inVertex = false;
  const propertyNames: string[] = [];
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] === 'element') {
      inVertex = tokens[1] === 'vertex';
      if (inVertex) vertexCount = Number(tokens[2]);
    } else if (tokens[0] === 'property' && inVertex) {
      if (tokens[1] !== 'float' || !tokens[2]) throw new Error('4GS vertex 只允许 Float32 标量属性。');
      propertyNames.push(tokens[2]);
    }
  }
  if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) throw new Error('4GS vertex 数量无效。');
  const required = [
    'x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'velocity_per_frame_0', 'velocity_per_frame_1', 'velocity_per_frame_2',
    'frame_center', 'sigma_frames', 'radius_frames',
  ];
  const names = new Set(propertyNames);
  for (const name of required) if (!names.has(name)) throw new Error(`4GS 缺少必需属性 ${name}。`);
  const restNames = propertyNames.filter((name) => /^f_rest_\d+$/.test(name));
  restNames.forEach((name, index) => {
    if (name !== `f_rest_${index}`) throw new Error(`4GS SH 属性不连续：${name}。`);
  });
  const recordBytes = propertyNames.length * FLOAT_BYTES;
  const vertexPayloadEnd = dataOffset + vertexCount * recordBytes;
  let metadata: Readonly<Record<string, unknown>> | null = null;
  if (version === 3) {
    if (source.size < vertexPayloadEnd + FOUR_GS_V3_FOOTER_BYTES) throw new Error('4GS v3 内嵌 metadata footer 被截断。');
    const footerBytes = new Uint8Array(await source.slice(source.size - FOUR_GS_V3_FOOTER_BYTES).arrayBuffer());
    const footerMagic = new TextDecoder('ascii').decode(footerBytes.subarray(0, 8));
    if (footerMagic !== FOUR_GS_V3_MAGIC) throw new Error(`4GS v3 footer magic 无效：${footerMagic}。`);
    const footer = new DataView(footerBytes.buffer, footerBytes.byteOffset, footerBytes.byteLength);
    const metadataBytes = Number(footer.getBigUint64(8, true));
    const expectedCrc = footer.getUint32(16, true);
    const metadataStart = source.size - FOUR_GS_V3_FOOTER_BYTES - metadataBytes;
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes <= 0 || metadataStart !== vertexPayloadEnd) {
      throw new Error('4GS v3 vertex 载荷、metadata 与 footer 长度不闭合。');
    }
    const encodedMetadata = new Uint8Array(await source.slice(metadataStart, metadataStart + metadataBytes).arrayBuffer());
    if (crc32(encodedMetadata) !== expectedCrc) throw new Error('4GS v3 metadata CRC32 校验失败。');
    const parsed = JSON.parse(new TextDecoder().decode(encodedMetadata)) as Record<string, unknown>;
    if (parsed.format !== 'easytimegspp-4dgs' || parsed.format_version !== 3
      || parsed.point_count !== vertexCount || parsed.property_count !== propertyNames.length
      || JSON.stringify(parsed.properties) !== JSON.stringify(propertyNames)) {
      throw new Error('4GS v3 内嵌 metadata 与 vertex 载荷不一致。');
    }
    const metadataTime = parsed.time as Record<string, unknown> | undefined;
    const metadataFrames = metadataTime?.frames;
    if (!Array.isArray(metadataFrames) || metadataFrames.length !== frameCount
      || metadataFrames[0] !== firstFrame || metadataFrames.at(-1) !== lastFrame
      || metadataFrames.some((frame, index) => frame !== firstFrame + index)) {
      throw new Error('4GS v3 内嵌 metadata 与文件头时间轴不一致。');
    }
    metadata = parsed;
  } else if (source.size !== vertexPayloadEnd) {
    throw new Error(`4GS 文件长度不闭合：应为 ${vertexPayloadEnd} 字节，实际 ${source.size} 字节。`);
  }
  const thresholdLine = lines.find((line) => /^comment\s+opacity_threshold\s+/i.test(line.trim()));
  const opacityThreshold = metadata && typeof metadata.opacity_threshold === 'number'
    ? metadata.opacity_threshold
    : thresholdLine ? Number(thresholdLine.trim().split(/\s+/).at(-1)) : 0;
  if (!Number.isFinite(opacityThreshold) || opacityThreshold < 0 || opacityThreshold >= 1) {
    throw new Error('4GS opacity_threshold 必须位于 [0, 1)。');
  }
  const timeMetadata = metadata?.time as Record<string, unknown> | undefined;
  const frameRate = typeof timeMetadata?.frame_rate === 'number' && Number.isFinite(timeMetadata.frame_rate) && timeMetadata.frame_rate > 0
    ? timeMetadata.frame_rate : 30;
  return {
    version, dataOffset, vertexCount, recordBytes, propertyNames,
    firstFrame, lastFrame, frameCount, shBands: shBands(restNames.length), opacityThreshold, frameRate, metadata,
  };
}

function staticTrack(components: number, values: readonly Raw4DScalarArray[]): Raw4DTrack {
  return { encoding: 'float32', components, keyframes: [0], values };
}

function logSigmoid(value: number): number {
  return value >= 0 ? -Math.log1p(Math.exp(-value)) : value - Math.log1p(Math.exp(value));
}

function alphaLogit(opacityLogit: number, logVisibility: number, threshold: number): number {
  // #WDD-gpt 2026-08-20 - 阈值判定复现 Torch/GPU Float32 舍入，真实 v3 的逐帧 active 计数必须与内嵌诊断逐项一致。
  const baseAlpha = Math.fround(1 / (1 + Math.exp(-opacityLogit)));
  const visibility = Math.fround(Math.exp(Math.fround(logVisibility)));
  const alpha = Math.fround(baseAlpha * visibility);
  if (threshold > 0 && alpha < Math.fround(threshold)) return -HALF_MAX;
  if (alpha <= 0) return -HALF_MAX;
  if (alpha >= 1) return HALF_MAX;
  const result = Math.log(alpha) - Math.log1p(-alpha);
  return Math.max(-HALF_MAX, Math.min(HALF_MAX, result));
}

function createStorage(options: Raw4DParseOptions, length: number): Float32Array {
  return (options.createStorage?.(length, 'float32') ?? new Float32Array(length)) as Float32Array;
}

export async function parseFourGs(source: Raw4DSource, options: Raw4DParseOptions = {}): Promise<Raw4DAsset> {
  options.onProgress?.({ ratio: 0.01, stage: 'header', message: '正在校验一体 4GS v2/v3 文件头' });
  const header = await readFourGsHeader(source);
  const count = header.vertexCount;
  const frames = Array.from({ length: header.frameCount }, (_, index) => index);
  const positionValues = Array.from({ length: header.frameCount > 1 ? 6 : 3 }, () => createStorage(options, count));
  const rotationValues = Array.from({ length: 4 }, () => createStorage(options, count));
  const colorValues = Array.from({ length: 3 }, () => createStorage(options, count));
  const scaleValues = Array.from({ length: 3 }, () => createStorage(options, count));
  const opacityValues = frames.map(() => createStorage(options, count));
  const shCount = [0, 9, 24, 45][header.shBands];
  const shRest = Array.from({ length: shCount }, () => createStorage(options, count));
  const lifetimeMu = createStorage(options, count);
  const lifetimeW = createStorage(options, count);

  const propertyIndex = new Map(header.propertyNames.map((name, index) => [name, index]));
  const index = (name: string): number => propertyIndex.get(name)!;
  const indexes = {
    x: index('x'), y: index('y'), z: index('z'),
    dc: [index('f_dc_0'), index('f_dc_1'), index('f_dc_2')],
    opacity: index('opacity'), scale: [index('scale_0'), index('scale_1'), index('scale_2')],
    rotation: [index('rot_0'), index('rot_1'), index('rot_2'), index('rot_3')],
    velocity: [index('velocity_per_frame_0'), index('velocity_per_frame_1'), index('velocity_per_frame_2')],
    center: index('frame_center'), sigma: index('sigma_frames'), radius: index('radius_frames'),
    sh: Array.from({ length: shCount }, (_, value) => index(`f_rest_${value}`)),
  };
  const chunkRows = Math.max(256, Math.floor(options.chunkRows ?? 8192));
  let minX = Number.POSITIVE_INFINITY; let minY = Number.POSITIVE_INFINITY; let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY; let maxY = Number.NEGATIVE_INFINITY; let maxZ = Number.NEGATIVE_INFINITY;
  for (let firstRow = 0; firstRow < count; firstRow += chunkRows) {
    if (options.signal?.aborted) throw new DOMException('4GS import was cancelled.', 'AbortError');
    const rowCount = Math.min(chunkRows, count - firstRow);
    const chunk = await source.slice(
      header.dataOffset + firstRow * header.recordBytes,
      header.dataOffset + (firstRow + rowCount) * header.recordBytes,
    ).arrayBuffer();
    const view = new DataView(chunk);
    for (let row = 0; row < rowCount; row += 1) {
      const stableId = firstRow + row;
      const base = row * header.recordBytes;
      const read = (property: number): number => view.getFloat32(base + property * FLOAT_BYTES, true);
      for (let property = 0; property < header.propertyNames.length; property += 1) {
        if (!Number.isFinite(read(property))) {
          throw new Error(`4GS 点 ${stableId} 的 ${header.propertyNames[property]} 不是有限 Float32。`);
        }
      }
      const center = read(indexes.center);
      const sigma = read(indexes.sigma);
      const radius = read(indexes.radius);
      if (sigma < 0 || radius < 0) throw new Error(`4GS 点 ${stableId} 的生命周期参数为负。`);
      const opacity = read(indexes.opacity);
      const logBaseAlpha = logSigmoid(opacity);
      const logThreshold = header.opacityThreshold > 0 ? Math.log(header.opacityThreshold) : Number.NEGATIVE_INFINITY;
      const supportRadius = header.opacityThreshold > 0
        ? logBaseAlpha < logThreshold ? 0 : radius + sigma * Math.sqrt(Math.max(0, logBaseAlpha - logThreshold))
        : radius + sigma * 3;
      const clampFrame = (value: number) => Math.max(header.firstFrame, Math.min(header.lastFrame, value));
      const endpointStart = clampFrame(center - supportRadius);
      const endpointEnd = clampFrame(center + supportRadius);
      const relativeStart = endpointStart - header.firstFrame;
      const relativeEnd = endpointEnd - header.firstFrame;
      lifetimeMu[stableId] = (relativeStart + relativeEnd) / 2;
      lifetimeW[stableId] = Math.max(0, (relativeEnd - relativeStart) / 2);
      const basePosition = [read(indexes.x), read(indexes.y), read(indexes.z)];
      const velocity = indexes.velocity.map(read);
      const writePosition = (bank: number, absoluteFrame: number) => {
        for (let axis = 0; axis < 3; axis += 1) {
          const value = basePosition[axis] + velocity[axis] * (absoluteFrame - center);
          positionValues[bank * 3 + axis][stableId] = value;
          if (axis === 0) { minX = Math.min(minX, value); maxX = Math.max(maxX, value); }
          else if (axis === 1) { minY = Math.min(minY, value); maxY = Math.max(maxY, value); }
          else { minZ = Math.min(minZ, value); maxZ = Math.max(maxZ, value); }
        }
      };
      writePosition(0, endpointStart);
      if (header.frameCount > 1) writePosition(1, endpointEnd);
      indexes.rotation.forEach((property, component) => { rotationValues[component][stableId] = read(property); });
      indexes.dc.forEach((property, component) => { colorValues[component][stableId] = read(property); });
      indexes.scale.forEach((property, component) => { scaleValues[component][stableId] = read(property); });
      indexes.sh.forEach((property, component) => { shRest[component][stableId] = read(property); });
      for (let frame = 0; frame < header.frameCount; frame += 1) {
        const delta = Math.abs(header.firstFrame + frame - center);
        const tail = Math.max(delta - radius, 0);
        const ratio = tail / Math.max(sigma, 1e-6);
        opacityValues[frame][stableId] = alphaLogit(opacity, -(ratio * ratio), header.opacityThreshold);
      }
    }
    const ratio = (firstRow + rowCount) / count;
    options.onProgress?.({ ratio: 0.05 + ratio * 0.9, stage: 'data', message: `正在转换 4GS 线性运动与生命周期 ${Math.round(ratio * 100)}%` });
  }
  const position: Raw4DTrack = {
    encoding: 'float32', components: 3,
    keyframes: header.frameCount > 1 ? [0, header.frameCount - 1] : [0], values: positionValues,
  };
  const opacity: Raw4DTrack = { encoding: 'float32', components: 1, keyframes: frames, values: opacityValues };
  const trackKeyframes = {
    position: position.keyframes,
    rotation: [0], colorDc: [0], scale: [0], opacity: opacity.keyframes,
  } as const;
  const bounds = calculateBounds(
    new Float32Array([minX, maxX]), new Float32Array([minY, maxY]), new Float32Array([minZ, maxZ]),
  );
  options.onProgress?.({ ratio: 1, stage: 'finalizing', message: '4GS 已进入统一 Canonical RAM' });
  return {
    sourceName: options.sourceName ?? 'scene.4gs', sourceEncoding: 'float32', splatCount: count,
    totalFrames: header.frameCount, frameRate: header.frameRate, shBands: header.shBands, position,
    rotation: staticTrack(4, rotationValues), colorDc: staticTrack(3, colorValues),
    scale: staticTrack(3, scaleValues), opacity, shRest, lifetimeMu, lifetimeW, bounds,
    positionTiming: 'per-point-lifetime-endpoints', opacityTiming: 'baked',
    temporalLayout: {
      schemaVersion: 1,
      interpolation: { position: 'linear', rotation: 'slerp', colorDc: 'linear', scale: 'linear', opacity: 'linear' },
      pointGroups: [{
        id: `fourgs-v${header.version}-linear`, firstPoint: 0, pointCount: count, sourceElement: 'normalized', trackKeyframes,
      }],
    },
  };
}
