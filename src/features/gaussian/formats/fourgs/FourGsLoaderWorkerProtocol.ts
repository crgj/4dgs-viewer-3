import type { Raw4DAsset, Raw4DParseProgress } from '../raw4d/Raw4DTypes';

// #WDD-gpt 2026-08-20 - 4GS 解码在专用 Worker 中完成，主线程只接收统一 Canonical RAM 所需 TypedArray。
export type FourGsLoaderWorkerRequest =
  | { readonly type: 'load'; readonly requestId: number; readonly file: File; readonly cpuBudgetBytes: number; readonly preferSharedMemory: boolean }
  | { readonly type: 'cancel'; readonly requestId: number }
  | { readonly type: 'release'; readonly bufferId: string };

export type FourGsLoaderWorkerResponse =
  | { readonly type: 'progress'; readonly requestId: number; readonly progress: Raw4DParseProgress }
  | {
    readonly type: 'loaded'; readonly requestId: number; readonly bufferId: string; readonly asset: Raw4DAsset;
    readonly cpuResidentBytes: number; readonly transport: 'shared-array-buffer' | 'transferable';
  }
  | { readonly type: 'error'; readonly requestId: number; readonly name: string; readonly message: string };
