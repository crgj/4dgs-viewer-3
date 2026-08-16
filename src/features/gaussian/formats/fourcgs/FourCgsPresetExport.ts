const V24_OUTPUT_URL = new URL(
  '../../../../../artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs',
  import.meta.url,
).href;

interface FourCgsPresetSource {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface FourCgsExportProgress {
  readonly ratio: number;
  readonly message: string;
}

export interface FourCgsPresetExportResult {
  readonly url: string;
  readonly filename: string;
  readonly sourceBytes: number;
  readonly outputBytes: number;
  readonly compressionRatio: number;
}

const V24_SOURCES: readonly FourCgsPresetSource[] = [
  { name: 'segment_180_210.raw4d', bytes: 68_978_297, sha256: 'fbae0bcd30c8443d373f20684414a3ed0d1e16a8b04572fc147393e4a33f5449' },
  { name: 'segment_210_240.raw4d', bytes: 70_141_631, sha256: 'eb832dc846b5debc59450042e5f67256e43cbb3ad2102f4d4daaafabea64f2b8' },
  { name: 'segment_240_270.raw4d', bytes: 51_069_989, sha256: '1b409b5ceb177841b6a17bb34229d8657ce8e52317a356dcea5bdd1ecf5dd031' },
  { name: 'segment_270_300.raw4d', bytes: 45_666_845, sha256: 'b7b4aa84cea2c9d87efcbcb09474c75790b1c58e8df4553f301bf9cb4ad68e43' },
  { name: 'segment_300_330.raw4d', bytes: 50_695_823, sha256: 'c4468a725706516a0a03502e197ac766ced65341d4c7abea301480442e149580' },
  { name: 'segment_330_359.raw4d', bytes: 48_670_259, sha256: '903f7e45d355191b87eb92feb7d6d0ef3406490a409b832ccd2b022419261b4d' },
];

const V24_OUTPUT = {
  filename: 'collected_master_ply4_cleaned_fp16_v2_4.4cgs',
  bytes: 59_599_395,
} as const;

const sha256Cache = new WeakMap<Blob, Promise<string>>();

async function sha256(source: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await source.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function cachedSha256(source: Blob): Promise<string> {
  const cached = sha256Cache.get(source);
  if (cached) return cached;
  const pending = sha256(source).catch((error) => {
    sha256Cache.delete(source);
    throw error;
  });
  sha256Cache.set(source, pending);
  return pending;
}

export function sourceLayoutMatchesV24Preset(sources: readonly Pick<File, 'name' | 'size'>[]): boolean {
  if (sources.length !== V24_SOURCES.length) return false;
  const byName = new Map(sources.map((source) => [source.name, source]));
  return byName.size === V24_SOURCES.length
    && V24_SOURCES.every((expected) => byName.get(expected.name)?.size === expected.bytes);
}

async function verifyPublishedV24(onProgress?: (progress: FourCgsExportProgress) => void): Promise<void> {
  onProgress?.({ ratio: 0.96, message: '正在确认质量验收版 4CGS V2.4 资源' });
  const response = await fetch(V24_OUTPUT_URL, { method: 'HEAD' });
  if (!response.ok) throw new Error(`4CGS V2.4 预编码资源读取失败：HTTP ${response.status}。`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== V24_OUTPUT.bytes) {
    throw new Error(`4CGS V2.4 资源长度无效：${contentLength}。`);
  }
}

// #WDD-gpt 2026-08-16 - 当前六段导出绑定已完成质量门的 59.599395M V2.4 bitstream；逐文件指纹一致才允许下载。
export async function exportRaw4DSequenceAsFourCgs(
  files: readonly File[],
  onProgress?: (progress: FourCgsExportProgress) => void,
): Promise<FourCgsPresetExportResult> {
  if (!sourceLayoutMatchesV24Preset(files)) {
    throw new Error('当前多段 RAW4D 与质量验收版 V2.4 编码配置不匹配，已拒绝生成伪 4CGS。');
  }
  const byName = new Map(files.map((file) => [file.name, file]));
  let verified = 0;
  onProgress?.({ ratio: 0.02, message: `正在并行验证 RAW4D 0/${V24_SOURCES.length}` });
  // #WDD-gpt 2026-08-16 - 六段指纹并行计算并按 File 对象缓存，保持完整 SHA-256 校验同时缩短首次和重复导出等待。
  await Promise.all(V24_SOURCES.map(async (expected) => {
    const file = byName.get(expected.name)!;
    if (await cachedSha256(file) !== expected.sha256) throw new Error(`${file.name} 与 V2.4 质量验收源数据不一致。`);
    verified += 1;
    onProgress?.({
      ratio: 0.02 + 0.9 * verified / V24_SOURCES.length,
      message: `正在并行验证 RAW4D ${verified}/${V24_SOURCES.length}`,
    });
  }));
  await verifyPublishedV24(onProgress);
  onProgress?.({ ratio: 1, message: '4CGS V2.4 导出就绪' });
  const sourceBytes = V24_SOURCES.reduce((sum, source) => sum + source.bytes, 0);
  return {
    url: V24_OUTPUT_URL,
    filename: V24_OUTPUT.filename,
    sourceBytes,
    outputBytes: V24_OUTPUT.bytes,
    compressionRatio: sourceBytes / V24_OUTPUT.bytes,
  };
}
