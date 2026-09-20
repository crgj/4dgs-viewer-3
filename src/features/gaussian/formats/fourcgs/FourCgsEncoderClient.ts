import type { FourCgsExportOptions, FourCgsProgress } from './FourCgsTypes';
import type { Raw4DMemorySnapshot } from '../raw4d/Raw4DTypes';

export interface FourCgsEncodeResult {
  readonly blob: Blob;
  readonly filename: string;
  readonly sourceBytes: number;
  readonly outputBytes: number;
  readonly compressionRatio: number;
  readonly sourceSha256: readonly string[];
  readonly originalPointCount: number;
  readonly encodedPointCount: number;
  readonly deletedPointCount: number;
  readonly encodeTimings?: {
    readonly totalMs: number;
    readonly workerCount: number;
    readonly stageMs: Readonly<Record<string, number>>;
  };
}

export type { FourCgsExportOptions } from './FourCgsTypes';

// #WDD-gpt 2026-09-20 - 新导出默认以 0.1 最大有效 Alpha 压实低贡献点，同时保留 SH3；UI 可显式切换 SH1/SH2。
export const DEFAULT_FOUR_CGS_EXPORT_OPTIONS: FourCgsExportOptions = {
  shLevel: 3,
  maximumEffectiveAlpha: 0.1,
};

interface WorkerProgressMessage {
  readonly type: 'progress';
  readonly progress: FourCgsProgress;
}

interface WorkerResultMessage {
  readonly type: 'result';
  readonly result: FourCgsEncodeResult;
}

interface WorkerErrorMessage {
  readonly type: 'error';
  readonly message: string;
}

type WorkerMessage = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage;

type WorkerEncodeRequest = {
  readonly type: 'files';
  readonly files: readonly File[];
  readonly deletionWords: readonly Uint32Array[];
  readonly options: FourCgsExportOptions;
} | {
  readonly type: 'memory';
  readonly sources: readonly Raw4DMemorySnapshot[];
  readonly options: FourCgsExportOptions;
};

function normalizeOptions(options: FourCgsExportOptions = DEFAULT_FOUR_CGS_EXPORT_OPTIONS): FourCgsExportOptions {
  const shLevel = Math.round(options.shLevel);
  if (shLevel !== 1 && shLevel !== 2 && shLevel !== 3) throw new Error(`4CGS SH 级别无效：${options.shLevel}。`);
  if (!Number.isFinite(options.maximumEffectiveAlpha)
    || options.maximumEffectiveAlpha < 0 || options.maximumEffectiveAlpha >= 1) {
    throw new Error(`4CGS 最大有效 Alpha 阈值必须位于 [0, 1)：${options.maximumEffectiveAlpha}。`);
  }
  return { shLevel, maximumEffectiveAlpha: options.maximumEffectiveAlpha };
}

function runEncoderWorker(
  request: WorkerEncodeRequest,
  transfer: readonly ArrayBuffer[],
  onProgress?: (progress: FourCgsProgress) => void,
  signal?: AbortSignal,
): Promise<FourCgsEncodeResult> {
  const worker = new Worker(new URL('./fourcgs-encoder.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<FourCgsEncodeResult>((resolve, reject) => {
    let settled = false;
    const startedAt = performance.now();
    let lastProgress: FourCgsProgress | undefined;
    let lastProgressAt = startedAt;
    // #WDD-gpt 2026-09-19 - 同步 WASM/JS 长阶段无法从 Worker 内定时回报；主线程每 15 秒刷新等待时长，明确区分“无新里程碑”和页面失去响应。
    const heartbeat = globalThis.setInterval(() => {
      if (settled || !lastProgress || !onProgress) return;
      const quietMs = performance.now() - lastProgressAt;
      if (quietMs < 15_000) return;
      onProgress({
        ...lastProgress,
        message: `${lastProgress.message} · 等待新里程碑 ${(quietMs / 1000).toFixed(0)} 秒`,
        elapsedMs: performance.now() - startedAt,
      });
    }, 15_000);
    const finish = () => {
      if (settled) return false;
      settled = true;
      globalThis.clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      reject(new DOMException('4CGS 保存已取消。', 'AbortError'));
    };
    worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'progress') {
        lastProgress = message.progress;
        lastProgressAt = performance.now();
        onProgress?.(message.progress);
        return;
      }
      if (!finish()) return;
      if (message.type === 'error') reject(new Error(message.message));
      else resolve(message.result);
    });
    worker.addEventListener('error', (event) => {
      if (!finish()) return;
      reject(new Error(event.message || '4CGS 编码 Worker 崩溃。'));
    }, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.postMessage(request, [...transfer]);
  });
}

// #WDD-gpt 2026-08-16 - 导出必须在独立 Worker 内读取本次 File 对象并重新编码，禁止再返回固定历史 4CGS 资源。
export function encodeRaw4DFilesAsFourCgs(
  files: readonly File[],
  deletionWords: readonly Uint32Array[],
  onProgress?: (progress: FourCgsProgress) => void,
  options: FourCgsExportOptions = DEFAULT_FOUR_CGS_EXPORT_OPTIONS,
): Promise<FourCgsEncodeResult> {
  if (files.length === 0) return Promise.reject(new Error('没有可编码的 RAW4D 文件。'));
  if (deletionWords.length !== files.length) {
    return Promise.reject(new Error(`RAW4D 删除位集数量不一致：${deletionWords.length}/${files.length}。`));
  }
  // #WDD-gpt 2026-08-16 - 只向 Worker 转移删除位集快照，运行时编辑位集继续留在主线程用于撤销和后续编辑。
  const snapshots = deletionWords.map((words) => words.slice());
  return runEncoderWorker(
    { type: 'files', files: [...files], deletionWords: snapshots, options: normalizeOptions(options) },
    snapshots.map((words) => words.buffer as ArrayBuffer),
    onProgress,
  );
}

// #WDD-gpt 2026-08-16 - 正式保存直接把 Canonical RAM 交给 Worker；共享内存零拷贝，兼容模式只克隆而不回读源文件。
export function encodeRaw4DMemoryAsFourCgs(
  sources: readonly Raw4DMemorySnapshot[],
  onProgress?: (progress: FourCgsProgress) => void,
  signal?: AbortSignal,
  options: FourCgsExportOptions = DEFAULT_FOUR_CGS_EXPORT_OPTIONS,
): Promise<FourCgsEncodeResult> {
  if (sources.length === 0) return Promise.reject(new Error('没有可编码的 RAW4D 内存快照。'));
  const snapshots = sources.map((source) => ({
    ...source,
    deletionWords: source.deletionWords.slice(),
  }));
  return runEncoderWorker(
    { type: 'memory', sources: snapshots, options: normalizeOptions(options) },
    snapshots.map((source) => source.deletionWords.buffer as ArrayBuffer),
    onProgress,
    signal,
  );
}
