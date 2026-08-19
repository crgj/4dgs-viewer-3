import type {
  FourCgsCameraBookmark,
  FourCgsCameraBookmarks,
  FourCgsFrameLocation,
  FourCgsManifest,
  FourCgsMetadata,
  FourCgsSceneTransform,
  FourCgsSegment,
  FourCgsStreamEntry,
} from './FourCgsTypes';
import { RAW4D_BUNDLE_CODEC_NAME, paddedEvenLength, raw4DBundleStreamName } from './FourCgsRaw4DBundle';

export const FOUR_CGS_MAGIC = '4CGSPRS2';
export const FOUR_CGS_HEADER_BYTES = 12;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface FourCgsTransformInput {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

export interface FourCgsCameraBookmarkInput {
  readonly distance: number;
  readonly pitch: number;
  readonly target: readonly [number, number, number];
  readonly yaw: number;
}

function finiteVector3(value: unknown, label: string, positive = false): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3
    || value.some((component) => !Number.isFinite(component)
      || (positive && (component as number) <= 0))) {
    throw new Error(`4CGS ${label} 必须是三个${positive ? '正' : ''}有限数值。`);
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}

function finiteNumber(value: unknown, label: string, positive = false): number {
  if (!Number.isFinite(value) || (positive && (value as number) <= 0)) {
    throw new Error(`4CGS ${label} 必须是${positive ? '正' : ''}有限数值。`);
  }
  return Number(value);
}

function createCameraBookmark(value: FourCgsCameraBookmarkInput, index: number): FourCgsCameraBookmark {
  return {
    distance: finiteNumber(value.distance, `metadata.cameraBookmarks.bookmarks[${index}].distance`, true),
    pitch: finiteNumber(value.pitch, `metadata.cameraBookmarks.bookmarks[${index}].pitch`),
    target: finiteVector3(value.target, `metadata.cameraBookmarks.bookmarks[${index}].target`),
    yaw: finiteNumber(value.yaw, `metadata.cameraBookmarks.bookmarks[${index}].yaw`),
  };
}

// #WDD-gpt 2026-08-19 - 4CGS 固定保存三个 Orbit 书签槽位，null 明确表示该槽未启用，避免旧场景书签串入新文件。
export function createFourCgsCameraBookmarks(
  bookmarks: readonly (FourCgsCameraBookmarkInput | null)[],
): FourCgsCameraBookmarks {
  if (bookmarks.length !== 3) throw new Error('4CGS 视角书签必须包含三个槽位。');
  return {
    schemaVersion: 1,
    coordinateSystem: 'playcanvas-y-up',
    bookmarks: bookmarks.map((bookmark, index) => bookmark === null ? null : createCameraBookmark(bookmark, index)) as [
      FourCgsCameraBookmark | null,
      FourCgsCameraBookmark | null,
      FourCgsCameraBookmark | null,
    ],
  };
}

export function createFourCgsSceneTransform(input: FourCgsTransformInput): FourCgsSceneTransform {
  return {
    schemaVersion: 1,
    coordinateSystem: 'playcanvas-y-up',
    units: 'meter',
    position: finiteVector3(input.position, 'metadata.sceneTransform.position'),
    rotationEulerDegrees: finiteVector3(input.rotation, 'metadata.sceneTransform.rotationEulerDegrees'),
    scale: finiteVector3(input.scale, 'metadata.sceneTransform.scale', true),
  };
}

export function fourCgsSceneTransformToInput(transform: FourCgsSceneTransform): {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
} {
  return {
    position: [...transform.position],
    rotation: [...transform.rotationEulerDegrees],
    scale: [...transform.scale],
  };
}

function validateSceneTransform(value: unknown): FourCgsSceneTransform | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('4CGS metadata.sceneTransform 无效。');
  const transform = value as Partial<FourCgsSceneTransform>;
  if (transform.schemaVersion !== 1 || transform.coordinateSystem !== 'playcanvas-y-up' || transform.units !== 'meter') {
    throw new Error('4CGS metadata.sceneTransform 坐标约定不受支持。');
  }
  return {
    schemaVersion: 1,
    coordinateSystem: 'playcanvas-y-up',
    units: 'meter',
    position: finiteVector3(transform.position, 'metadata.sceneTransform.position'),
    rotationEulerDegrees: finiteVector3(transform.rotationEulerDegrees, 'metadata.sceneTransform.rotationEulerDegrees'),
    scale: finiteVector3(transform.scale, 'metadata.sceneTransform.scale', true),
  };
}

function validateCameraBookmarks(value: unknown): FourCgsCameraBookmarks | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('4CGS metadata.cameraBookmarks 无效。');
  }
  const cameraBookmarks = value as Partial<FourCgsCameraBookmarks>;
  if (cameraBookmarks.schemaVersion !== 1 || cameraBookmarks.coordinateSystem !== 'playcanvas-y-up'
    || !Array.isArray(cameraBookmarks.bookmarks)) {
    throw new Error('4CGS metadata.cameraBookmarks 坐标约定或槽位无效。');
  }
  return createFourCgsCameraBookmarks(cameraBookmarks.bookmarks);
}

function validateMetadata(value: unknown): FourCgsMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('4CGS metadata 必须是对象。');
  }
  const metadata = value as FourCgsMetadata;
  const sceneTransform = validateSceneTransform(metadata.sceneTransform);
  const cameraBookmarks = validateCameraBookmarks(metadata.cameraBookmarks);
  return {
    ...metadata,
    ...(sceneTransform ? { sceneTransform } : {}),
    ...(cameraBookmarks ? { cameraBookmarks } : {}),
  };
}

function validateRaw4DBundle(manifest: Partial<FourCgsManifest>, segments: readonly FourCgsSegment[], streams: readonly FourCgsStreamEntry[]): void {
  const bundle = manifest.metadata?.raw4dBundle;
  if (!bundle || bundle.version !== 1 || bundle.exactSourceBytes !== true) throw new Error('4CGS RAW4D Bundle 缺少有效元数据。');
  const count = segments.length;
  if (!Number.isSafeInteger(bundle.chunkBytes) || bundle.chunkBytes <= 0 || bundle.chunkBytes % 2 !== 0
    || ![bundle.segmentChunkCounts, bundle.sourceNames, bundle.sourceByteLengths, bundle.sourceSha256]
      .every((values) => Array.isArray(values) && values.length === count)) {
    throw new Error('4CGS RAW4D Bundle 段目录长度不一致。');
  }
  let expectedStreamCount = 0;
  for (let index = 0; index < count; index += 1) {
    const sourceBytes = bundle.sourceByteLengths[index];
    const chunkCount = bundle.segmentChunkCounts[index];
    if (typeof bundle.sourceNames[index] !== 'string' || bundle.sourceNames[index].length === 0
      || !Number.isSafeInteger(sourceBytes) || sourceBytes <= 0
      || !Number.isSafeInteger(chunkCount) || chunkCount !== Math.ceil(sourceBytes / bundle.chunkBytes)
      || !/^[0-9a-f]{64}$/i.test(bundle.sourceSha256[index] ?? '')) {
      throw new Error(`4CGS RAW4D Bundle 第 ${index + 1} 段目录无效。`);
    }
    expectedStreamCount += chunkCount;
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const chunkSourceBytes = Math.min(bundle.chunkBytes, sourceBytes - chunkIndex * bundle.chunkBytes);
      const stream = streams.find((entry) => entry.name === raw4DBundleStreamName(index, chunkIndex));
      if (!stream || stream.compression !== 'deflate-shuffle16' || stream.rawBytes !== paddedEvenLength(chunkSourceBytes)) {
        throw new Error(`4CGS RAW4D Bundle 第 ${index + 1} 段第 ${chunkIndex + 1} 块目录无效。`);
      }
    }
  }
  if (streams.length !== expectedStreamCount) throw new Error('4CGS RAW4D Bundle 包含未登记的额外流。');
}

function sceneTransformsEqual(first: FourCgsSceneTransform, second: FourCgsSceneTransform): boolean {
  return first.schemaVersion === second.schemaVersion
    && first.coordinateSystem === second.coordinateSystem
    && first.units === second.units
    && first.position.every((value, index) => value === second.position[index])
    && first.rotationEulerDegrees.every((value, index) => value === second.rotationEulerDegrees[index])
    && first.scale.every((value, index) => value === second.scale[index]);
}

function cameraBookmarksEqual(first: FourCgsCameraBookmarks, second: FourCgsCameraBookmarks): boolean {
  return first.schemaVersion === second.schemaVersion
    && first.coordinateSystem === second.coordinateSystem
    && first.bookmarks.every((bookmark, index) => {
      const other = second.bookmarks[index];
      return bookmark === null || other === null
        ? bookmark === other
        : bookmark.distance === other.distance
          && bookmark.pitch === other.pitch
          && bookmark.yaw === other.yaw
          && bookmark.target.every((value, component) => value === other.target[component]);
    });
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`4CGS ${label} 必须是正整数。`);
  }
  return value as number;
}

function validateSegment(value: unknown, index: number): FourCgsSegment {
  if (!value || typeof value !== 'object') throw new Error(`4CGS 第 ${index + 1} 段清单无效。`);
  const segment = value as Partial<FourCgsSegment>;
  if (typeof segment.name !== 'string' || !segment.bankCounts) throw new Error(`4CGS 第 ${index + 1} 段缺少名称或属性银行。`);
  positiveInteger(segment.gaussianCount, `${segment.name}.gaussianCount`);
  positiveInteger(segment.totalFrames, `${segment.name}.totalFrames`);
  for (const key of ['position', 'rotation', 'colorDc', 'scale', 'opacity'] as const) {
    positiveInteger(segment.bankCounts[key], `${segment.name}.bankCounts.${key}`);
    if (segment.keyframeStrides) positiveInteger(segment.keyframeStrides[key], `${segment.name}.keyframeStrides.${key}`);
  }
  if (!Number.isSafeInteger(segment.firstFrame) || !Number.isSafeInteger(segment.lastFrame) || segment.lastFrame! < segment.firstFrame!) {
    throw new Error(`4CGS ${segment.name} 帧范围无效。`);
  }
  return segment as FourCgsSegment;
}

function validateStream(value: unknown, index: number): FourCgsStreamEntry {
  if (!value || typeof value !== 'object') throw new Error(`4CGS 第 ${index + 1} 条流清单无效。`);
  const stream = value as Partial<FourCgsStreamEntry>;
  if (typeof stream.name !== 'string' || !['raw', 'deflate', 'deflate-shuffle16', 'brotli', 'brotli-shuffle16'].includes(stream.compression ?? '')) {
    throw new Error(`4CGS 第 ${index + 1} 条流名称或压缩方式无效。`);
  }
  positiveInteger(stream.rawBytes, `${stream.name}.rawBytes`);
  positiveInteger(stream.storedBytes, `${stream.name}.storedBytes`);
  if (!/^[0-9a-f]{64}$/i.test(stream.rawSha256 ?? '') || !/^[0-9a-f]{64}$/i.test(stream.storedSha256 ?? '')) {
    throw new Error(`4CGS ${stream.name} 缺少 SHA-256。`);
  }
  return stream as FourCgsStreamEntry;
}

export function validateFourCgsManifest(value: unknown, fileBytes?: number): FourCgsManifest {
  if (!value || typeof value !== 'object') throw new Error('4CGS 清单不是对象。');
  const manifest = value as Partial<FourCgsManifest>;
  if (manifest.format !== '4CGS' || manifest.version !== 2) throw new Error(`不支持的 4CGS 版本：${String(manifest.version)}。`);
  if (typeof manifest.codecName !== 'string' || !Array.isArray(manifest.segments) || !Array.isArray(manifest.streams)) {
    throw new Error('4CGS 清单缺少 codecName、segments 或 streams。');
  }
  positiveInteger(manifest.slotCount, 'slotCount');
  positiveInteger(manifest.uniqueFrameCount, 'uniqueFrameCount');
  const segments = manifest.segments.map(validateSegment);
  const streams = manifest.streams.map(validateStream);
  const metadata = validateMetadata(manifest.metadata);
  if (segments.length === 0 || streams.length === 0) throw new Error('4CGS 清单不得为空。');
  const streamNames = new Set<string>();
  for (const stream of streams) {
    if (streamNames.has(stream.name)) throw new Error(`4CGS 流名称重复：${stream.name}。`);
    streamNames.add(stream.name);
  }
  if (manifest.codecName === RAW4D_BUNDLE_CODEC_NAME) {
    // #WDD-gpt 2026-08-16 - 动态 RAW4D Bundle 直接保存本次拖入段，不得拿 V2.4 属性流目录误判或偷偷回退到固定成品。
    validateRaw4DBundle({ ...manifest, metadata }, segments, streams);
  } else {
    // #WDD-gpt 2026-08-16 - V2.6 可把 Scale 三轴独立压缩以并行编码；继续接受旧版单一 tattr_scale 流。
    const required = ['active_masks', 'prs_position', 'so3_rotation', 'tattr_dc', 'mixsc_opacity', 'lifetime_mu', 'lifetime_w', 'coresh5r_shared'];
    const missing = required.find((name) => !streamNames.has(name));
    if (missing) throw new Error(`4CGS V2.4 缺少必需流：${missing}。`);
    const hasLegacyScale = streamNames.has('tattr_scale');
    const scaleAxisNames = ['tattr_scale_0', 'tattr_scale_1', 'tattr_scale_2'];
    const hasSplitScale = scaleAxisNames.every((name) => streamNames.has(name));
    if (!hasLegacyScale && !hasSplitScale) {
      const partialAxis = scaleAxisNames.find((name) => streamNames.has(name));
      throw new Error(partialAxis
        ? '4CGS V2.6 的 Scale 三轴流不完整。'
        : '4CGS V2.4 缺少必需流：tattr_scale。');
    }
  }
  if (fileBytes !== undefined) {
    const storedBytes = streams.reduce((sum, stream) => sum + stream.storedBytes, 0);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (FOUR_CGS_HEADER_BYTES + manifestBytes + storedBytes !== fileBytes) {
      throw new Error('4CGS 文件长度与流目录不一致。');
    }
  }
  return {
    ...manifest,
    segments,
    streams,
    ...(metadata ? { metadata } : {}),
  } as FourCgsManifest;
}

export async function readFourCgsManifest(source: Blob): Promise<{ manifest: FourCgsManifest; manifestBytes: number }> {
  if (source.size < FOUR_CGS_HEADER_BYTES) throw new Error('4CGS 文件头被截断。');
  const header = new Uint8Array(await source.slice(0, FOUR_CGS_HEADER_BYTES).arrayBuffer());
  if (new TextDecoder('ascii').decode(header.subarray(0, 8)) !== FOUR_CGS_MAGIC) throw new Error('不是受支持的 4CGS V2 文件。');
  const manifestBytes = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(8, true);
  if (manifestBytes <= 0 || manifestBytes > MAX_MANIFEST_BYTES || FOUR_CGS_HEADER_BYTES + manifestBytes > source.size) {
    throw new Error('4CGS 清单长度无效。');
  }
  const manifestText = await source.slice(FOUR_CGS_HEADER_BYTES, FOUR_CGS_HEADER_BYTES + manifestBytes).text();
  const value = JSON.parse(manifestText) as unknown;
  const manifest = validateFourCgsManifest(value);
  const storedBytes = manifest.streams.reduce((sum, stream) => sum + stream.storedBytes, 0);
  if (FOUR_CGS_HEADER_BYTES + manifestBytes + storedBytes !== source.size) throw new Error('4CGS 文件长度与流目录不一致。');
  return { manifest, manifestBytes };
}

// #WDD-gpt 2026-08-16 - 保留浮点帧时间用于关键帧间插值；六段重复边界仍选择后一段 local=0。
export function locateFourCgsFrame(segments: readonly FourCgsSegment[], globalFrame: number): FourCgsFrameLocation {
  if (segments.length === 0) throw new Error('4CGS 没有时间段。');
  const firstFrame = segments[0].firstFrame;
  const lastFrame = segments.at(-1)!.lastFrame;
  const sourceFrame = Math.max(firstFrame, Math.min(lastFrame, firstFrame + globalFrame));
  let segmentIndex = 0;
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].firstFrame <= sourceFrame) segmentIndex = index;
    else break;
  }
  const segment = segments[segmentIndex];
  return {
    segmentIndex,
    localFrame: Math.max(0, Math.min(segment.totalFrames - 1, sourceFrame - segment.firstFrame)),
    sourceFrame,
  };
}

// #WDD-gpt 2026-08-19 - 4CGS Save As 只重写清单区并保留全部压缩流原字节，使场景变换与视角书签可往返而不重新编码 Gaussian。
export async function writeFourCgsFile(
  source: Blob,
  transform?: FourCgsTransformInput,
  cameraBookmarkInputs?: readonly (FourCgsCameraBookmarkInput | null)[],
): Promise<Blob> {
  const { manifest, manifestBytes } = await readFourCgsManifest(source);
  if (!transform && cameraBookmarkInputs === undefined) return source.slice(0, source.size, 'application/x-4cgs');
  const sceneTransform = transform ? createFourCgsSceneTransform(transform) : undefined;
  const cameraBookmarks = cameraBookmarkInputs === undefined
    ? undefined
    : createFourCgsCameraBookmarks(cameraBookmarkInputs);
  const nextManifest: FourCgsManifest = {
    ...manifest,
    metadata: {
      ...manifest.metadata,
      ...(sceneTransform ? { sceneTransform } : {}),
      ...(cameraBookmarks ? { cameraBookmarks } : {}),
    },
  };
  const nextManifestBytes = new TextEncoder().encode(JSON.stringify(nextManifest));
  if (nextManifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('4CGS 清单超过 8MB 限制。');
  const header = new Uint8Array(FOUR_CGS_HEADER_BYTES);
  header.set(new TextEncoder().encode(FOUR_CGS_MAGIC));
  new DataView(header.buffer).setUint32(8, nextManifestBytes.byteLength, true);
  const streams = source.slice(FOUR_CGS_HEADER_BYTES + manifestBytes);
  const output = new Blob([header, nextManifestBytes, streams], { type: 'application/x-4cgs' });
  // #WDD-gpt 2026-08-19 - 写完重新解析并逐项比对 TRS 与三个书签，避免清单可读但场景元数据被覆盖或精度丢失。
  const verified = await readFourCgsManifest(output);
  if (sceneTransform && (!verified.manifest.metadata?.sceneTransform
    || !sceneTransformsEqual(verified.manifest.metadata.sceneTransform, sceneTransform))) {
    throw new Error('4CGS 完整场景变换写后校验失败。');
  }
  if (cameraBookmarks && (!verified.manifest.metadata?.cameraBookmarks
    || !cameraBookmarksEqual(verified.manifest.metadata.cameraBookmarks, cameraBookmarks))) {
    throw new Error('4CGS 视角书签写后校验失败。');
  }
  return output;
}
