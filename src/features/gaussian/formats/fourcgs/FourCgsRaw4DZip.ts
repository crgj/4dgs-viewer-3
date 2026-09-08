import { Unzip, UnzipInflate, Zip, ZipPassThrough, type UnzipFile } from 'fflate';

const FOUR_CGS_ZIP_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const ZIP_SIGNATURES = new Set(['50-4b-03-04', '50-4b-05-06', '50-4b-07-08']);

export interface FourCgsRaw4DZipProgress {
  readonly archiveBytesRead: number;
  readonly archiveBytesTotal: number;
  readonly completedSegments: number;
  readonly discoveredSegments: number;
  readonly entryName?: string;
  readonly ratio: number;
}

export interface FourCgsRaw4DZipExtractOptions {
  readonly onProgress?: (progress: FourCgsRaw4DZipProgress) => void;
  readonly signal?: AbortSignal;
}

export type FourCgsRaw4DZipChunkWriter = (chunk: Uint8Array) => Promise<void>;

function abortError(): DOMException {
  return new DOMException('4CGS ZIP 解包已取消。', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function normalizedRaw4DEntryName(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw new Error(`4CGS ZIP 包含无效路径：${entryName}`);
  }
  const basename = parts.at(-1)!;
  return /\.raw4d$/i.test(basename) ? basename : null;
}

export async function isFourCgsRaw4DZip(source: Blob): Promise<boolean> {
  if (source.size < 4) return false;
  const bytes = new Uint8Array(await source.slice(0, 4).arrayBuffer());
  return ZIP_SIGNATURES.has([...bytes].map((value) => value.toString(16).padStart(2, '0')).join('-'));
}

// #WDD-gpt 2026-09-07 - 新 4CGS ZIP 在浏览器内分块解包；只暴露 RAW4D 文件，不写临时目录也不依赖后端服务。
export async function extractRaw4DFilesFromFourCgsZip(
  source: File,
  options: FourCgsRaw4DZipExtractOptions = {},
): Promise<readonly File[]> {
  throwIfAborted(options.signal);
  if (!await isFourCgsRaw4DZip(source)) throw new Error('该 .4cgs 文件不是 ZIP 容器。');

  const extracted: Array<File | undefined> = [];
  const seenBasenames = new Set<string>();
  const activeEntries = new Set<UnzipFile>();
  let completedSegments = 0;
  let pendingSegments = 0;
  let archiveFinished = false;
  let failure: Error | null = null;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const fail = (error: unknown) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    for (const entry of activeEntries) entry.terminate();
    activeEntries.clear();
    rejectCompletion(failure);
  };
  const finishIfReady = () => {
    if (!failure && archiveFinished && pendingSegments === 0) resolveCompletion();
  };
  const publish = (archiveBytesRead: number, entryName?: string) => options.onProgress?.({
    archiveBytesRead,
    archiveBytesTotal: source.size,
    completedSegments,
    discoveredSegments: extracted.length,
    entryName,
    ratio: source.size > 0 ? Math.min(1, archiveBytesRead / source.size) : 1,
  });

  const unzip = new Unzip((entry) => {
    if (failure) return;
    let basename: string | null;
    try {
      basename = normalizedRaw4DEntryName(entry.name);
    } catch (error) {
      fail(error);
      return;
    }
    if (!basename) return;
    const identity = basename.toLowerCase();
    if (seenBasenames.has(identity)) {
      fail(new Error(`4CGS ZIP 包含重复的 RAW4D 文件名：${basename}`));
      return;
    }
    if (entry.compression !== 0 && entry.compression !== 8) {
      fail(new Error(`4CGS ZIP 的 ${basename} 使用了不支持的压缩方法 ${entry.compression}。`));
      return;
    }
    seenBasenames.add(identity);
    const outputIndex = extracted.length;
    extracted.push(undefined);
    pendingSegments += 1;
    activeEntries.add(entry);
    const chunks: ArrayBuffer[] = [];
    entry.ondata = (error, data, final) => {
      if (error) {
        fail(error);
        return;
      }
      if (options.signal?.aborted) {
        fail(abortError());
        return;
      }
      if (data.byteLength > 0) chunks.push(data.slice().buffer as ArrayBuffer);
      if (!final) return;
      activeEntries.delete(entry);
      extracted[outputIndex] = new File(chunks, basename, {
        type: 'application/octet-stream',
        lastModified: source.lastModified,
      });
      completedSegments += 1;
      pendingSegments -= 1;
      publish(source.size, basename);
      finishIfReady();
    };
    try {
      entry.start();
    } catch (error) {
      fail(error);
    }
  });
  unzip.register(UnzipInflate);

  try {
    for (let offset = 0; offset < source.size; offset += FOUR_CGS_ZIP_READ_CHUNK_BYTES) {
      throwIfAborted(options.signal);
      const end = Math.min(source.size, offset + FOUR_CGS_ZIP_READ_CHUNK_BYTES);
      const chunk = new Uint8Array(await source.slice(offset, end).arrayBuffer());
      throwIfAborted(options.signal);
      unzip.push(chunk, end === source.size);
      if (failure) throw failure;
      publish(end);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    archiveFinished = true;
    finishIfReady();
    await completion;
  } catch (error) {
    fail(error);
    await completion;
  }

  const files = extracted.filter((file): file is File => Boolean(file));
  if (files.length < 2) throw new Error('4CGS ZIP 至少需要包含两个 .raw4d 片段。');
  publish(source.size);
  return files;
}

function archiveEntryName(filename: string): string {
  const basename = filename.replace(/\\/g, '/').split('/').at(-1) ?? '';
  if (!/^[^/\\\0]+\.raw4d$/i.test(basename) || basename === '.' || basename === '..') {
    throw new Error(`4CGS ZIP RAW4D 文件名无效：${filename}`);
  }
  return basename;
}

// #WDD-gpt 2026-09-07 - ZIP 输出使用 Stored 流逐块提交到已授权文件句柄，避免大序列额外累计整包 Blob。
export class FourCgsRaw4DZipWriter {
  private readonly archive: Zip;
  private readonly names = new Set<string>();
  private pendingWrite: Promise<void> = Promise.resolve();
  private finalPromise: Promise<void>;
  private finalResolve!: () => void;
  private finalReject!: (error: Error) => void;
  private closed = false;
  private failed: Error | null = null;
  private bytesWritten = 0;

  constructor(private readonly writeChunk: FourCgsRaw4DZipChunkWriter) {
    this.finalPromise = new Promise<void>((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
    });
    this.archive = new Zip((error, data, final) => {
      if (error) {
        this.fail(error);
        return;
      }
      if (data.byteLength > 0) {
        const stableChunk = data.slice();
        this.bytesWritten += stableChunk.byteLength;
        this.pendingWrite = this.pendingWrite.then(() => this.writeChunk(stableChunk));
      }
      if (final) {
        void this.pendingWrite.then(this.finalResolve, (writeError) => this.fail(writeError));
      }
    });
  }

  get outputBytes(): number {
    return this.bytesWritten;
  }

  get fileCount(): number {
    return this.names.size;
  }

  async addRaw4D(filename: string, blob: Blob, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('4CGS ZIP writer is already closed.');
    throwIfAborted(signal);
    const entryName = archiveEntryName(filename);
    const identity = entryName.toLowerCase();
    if (this.names.has(identity)) throw new Error(`4CGS ZIP 包含重复的 RAW4D 文件名：${entryName}`);
    this.names.add(identity);
    const entry = new ZipPassThrough(entryName);
    this.archive.add(entry);
    if (blob.size === 0) {
      entry.push(new Uint8Array(), true);
      await this.flush();
      return;
    }
    for (let offset = 0; offset < blob.size; offset += FOUR_CGS_ZIP_READ_CHUNK_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(blob.size, offset + FOUR_CGS_ZIP_READ_CHUNK_BYTES);
      const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      throwIfAborted(signal);
      entry.push(chunk, end === blob.size);
      await this.flush();
    }
  }

  async close(): Promise<{ readonly fileCount: number; readonly outputBytes: number }> {
    if (this.closed) throw new Error('4CGS ZIP writer is already closed.');
    if (this.names.size < 2) throw new Error('4CGS ZIP 至少需要写入两个 .raw4d 片段。');
    this.closed = true;
    this.archive.end();
    await this.finalPromise;
    await this.flush();
    return { fileCount: this.names.size, outputBytes: this.bytesWritten };
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.archive.terminate();
  }

  private async flush(): Promise<void> {
    await this.pendingWrite;
    if (this.failed) throw this.failed;
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = error instanceof Error ? error : new Error(String(error));
    this.finalReject(this.failed);
  }
}
