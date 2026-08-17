export interface FourCgsGalleryItem {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly snapshot: string;
  readonly description: string;
  readonly fileBytes: number;
  readonly sourceBytes: number;
  readonly frameCount: number;
  readonly frameRange: readonly [number, number];
  readonly segmentCount: number;
  readonly gaussianCount: number;
  readonly sourceGaussianCount: number;
  readonly deletedGaussianCount: number;
  readonly codec: string;
  readonly codecName: string;
  readonly tags: readonly string[];
  readonly assetUrl: string;
  readonly snapshotUrl: string;
}

export interface FourCgsGalleryManifest {
  readonly version: 1;
  readonly updatedAt: string;
  readonly items: readonly FourCgsGalleryItem[];
}

type GalleryManifestSource = Omit<FourCgsGalleryManifest, 'items'> & {
  readonly items: ReadonlyArray<Omit<FourCgsGalleryItem, 'assetUrl' | 'snapshotUrl'>>;
};

const finiteNonNegativeInteger = (value: unknown): value is number => (
  Number.isSafeInteger(value) && Number(value) >= 0
);

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

// #WDD-gpt 2026-08-17 - 相册清单在进入 UI 前严格校验，避免缺失说明、快照或统计时渲染半成品卡片。
export function parseFourCgsGalleryManifest(value: unknown, manifestUrl: string): FourCgsGalleryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('4CGS 相册清单不是对象。');
  const manifest = value as Partial<GalleryManifestSource>;
  if (manifest.version !== 1 || !nonEmptyString(manifest.updatedAt) || !Array.isArray(manifest.items)) {
    throw new Error('4CGS 相册清单版本、日期或项目列表无效。');
  }
  const ids = new Set<string>();
  const items = manifest.items.map((raw, index): FourCgsGalleryItem => {
    const item = raw as Partial<Omit<FourCgsGalleryItem, 'assetUrl' | 'snapshotUrl'>>;
    for (const key of ['id', 'name', 'file', 'snapshot', 'description', 'codec', 'codecName'] as const) {
      if (!nonEmptyString(item[key])) throw new Error(`4CGS 相册第 ${index + 1} 项缺少 ${key}。`);
    }
    if (ids.has(item.id!)) throw new Error(`4CGS 相册 ID 重复：${item.id}。`);
    ids.add(item.id!);
    for (const key of ['fileBytes', 'sourceBytes', 'frameCount', 'segmentCount', 'gaussianCount', 'sourceGaussianCount', 'deletedGaussianCount'] as const) {
      if (!finiteNonNegativeInteger(item[key])) throw new Error(`4CGS 相册 ${item.id}.${key} 无效。`);
    }
    if (!Array.isArray(item.frameRange) || item.frameRange.length !== 2
      || !item.frameRange.every(finiteNonNegativeInteger) || item.frameRange[1]! < item.frameRange[0]!) {
      throw new Error(`4CGS 相册 ${item.id}.frameRange 无效。`);
    }
    if (!Array.isArray(item.tags) || item.tags.some((tag) => !nonEmptyString(tag))) {
      throw new Error(`4CGS 相册 ${item.id}.tags 无效。`);
    }
    const baseUrl = new URL('.', manifestUrl);
    return {
      ...(item as Omit<FourCgsGalleryItem, 'assetUrl' | 'snapshotUrl'>),
      assetUrl: new URL(item.file!, baseUrl).href,
      snapshotUrl: new URL(item.snapshot!, baseUrl).href,
    };
  });
  return { version: 1, updatedAt: manifest.updatedAt, items };
}

export async function loadFourCgsGalleryManifest(
  manifestUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<FourCgsGalleryManifest> {
  const response = await fetcher(manifestUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`4CGS 相册清单读取失败：HTTP ${response.status}。`);
  return parseFourCgsGalleryManifest(await response.json(), response.url || manifestUrl);
}

export async function fetchFourCgsGalleryFile(
  item: FourCgsGalleryItem,
  onProgress?: (ratio: number) => void,
  fetcher: typeof fetch = fetch,
): Promise<File> {
  const response = await fetcher(item.assetUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${item.name} 读取失败：HTTP ${response.status}。`);
  const expectedBytes = Number(response.headers.get('content-length')) || item.fileBytes;
  const reader = response.body?.getReader();
  let blob: Blob;
  if (!reader) {
    blob = await response.blob();
    onProgress?.(1);
  } else {
    const chunks: ArrayBuffer[] = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk.buffer);
      receivedBytes += value.byteLength;
      onProgress?.(Math.max(0, Math.min(0.99, receivedBytes / Math.max(1, expectedBytes))));
    }
    blob = new Blob(chunks, { type: 'application/octet-stream' });
    onProgress?.(1);
  }
  if (blob.size !== item.fileBytes) {
    throw new Error(`${item.name} 文件长度不匹配：预期 ${item.fileBytes}，实际 ${blob.size}。`);
  }
  const filename = decodeURIComponent(item.file.split('/').at(-1) ?? `${item.id}.4cgs`);
  return new File([blob], filename, { type: 'application/octet-stream', lastModified: Date.now() });
}

export const fourCgsGalleryManifestUrl = () => new URL('4cgs/gallery.json', document.baseURI).href;
