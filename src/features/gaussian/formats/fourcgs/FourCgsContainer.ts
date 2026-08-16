import type {
  FourCgsFrameLocation,
  FourCgsManifest,
  FourCgsSegment,
  FourCgsStreamEntry,
} from './FourCgsTypes';

export const FOUR_CGS_MAGIC = '4CGSPRS2';
export const FOUR_CGS_HEADER_BYTES = 12;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

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
  }
  if (!Number.isSafeInteger(segment.firstFrame) || !Number.isSafeInteger(segment.lastFrame) || segment.lastFrame! < segment.firstFrame!) {
    throw new Error(`4CGS ${segment.name} 帧范围无效。`);
  }
  return segment as FourCgsSegment;
}

function validateStream(value: unknown, index: number): FourCgsStreamEntry {
  if (!value || typeof value !== 'object') throw new Error(`4CGS 第 ${index + 1} 条流清单无效。`);
  const stream = value as Partial<FourCgsStreamEntry>;
  if (typeof stream.name !== 'string' || !['raw', 'deflate', 'brotli', 'brotli-shuffle16'].includes(stream.compression ?? '')) {
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
  if (segments.length === 0 || streams.length === 0) throw new Error('4CGS 清单不得为空。');
  const streamNames = new Set<string>();
  for (const stream of streams) {
    if (streamNames.has(stream.name)) throw new Error(`4CGS 流名称重复：${stream.name}。`);
    streamNames.add(stream.name);
  }
  const required = ['active_masks', 'prs_position', 'so3_rotation', 'tattr_scale', 'tattr_dc', 'mixsc_opacity', 'lifetime_mu', 'lifetime_w', 'coresh5r_shared'];
  const missing = required.find((name) => !streamNames.has(name));
  if (missing) throw new Error(`4CGS V2.4 缺少必需流：${missing}。`);
  if (fileBytes !== undefined) {
    const storedBytes = streams.reduce((sum, stream) => sum + stream.storedBytes, 0);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (FOUR_CGS_HEADER_BYTES + manifestBytes + storedBytes !== fileBytes) {
      throw new Error('4CGS 文件长度与流目录不一致。');
    }
  }
  return { ...manifest, segments, streams } as FourCgsManifest;
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

// #WDD-gpt 2026-08-16 - 六段边界帧只出现一次；边界时选择后一段 local=0，完整时间轴严格保持 180 帧。
export function locateFourCgsFrame(segments: readonly FourCgsSegment[], globalFrame: number): FourCgsFrameLocation {
  if (segments.length === 0) throw new Error('4CGS 没有时间段。');
  const firstFrame = segments[0].firstFrame;
  const lastFrame = segments.at(-1)!.lastFrame;
  const sourceFrame = Math.max(firstFrame, Math.min(lastFrame, firstFrame + Math.round(globalFrame)));
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

// #WDD-gpt 2026-08-16 - Save As 先完整验证容器目录，再返回同字节 Blob，禁止把单段 RAW4D 冒充成 4CGS。
export async function writeFourCgsFile(source: File): Promise<Blob> {
  await readFourCgsManifest(source);
  return source.slice(0, source.size, 'application/x-4cgs');
}
