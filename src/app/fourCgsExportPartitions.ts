import type { FourCgsExportOptions } from '../features/gaussian/formats/fourcgs/FourCgsTypes';

export interface FourCgsPartitionExportOptions extends FourCgsExportOptions {
  readonly filenamePrefix: string;
  readonly partCount: number;
}

// #WDD-gpt 2026-09-20 - 多部分 4CGS 只在原始片段边界分组，按时间顺序均衡分配且不采样。
export function partitionConsecutiveSegments<T>(segments: readonly T[], partCount: number): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(partCount) || partCount < 1) throw new Error(`4CGS 输出部分数无效：${partCount}。`);
  if (partCount > segments.length) throw new Error(`4CGS 输出部分数 ${partCount} 超过原始片段数 ${segments.length}。`);
  const base = Math.floor(segments.length / partCount);
  const remainder = segments.length % partCount;
  let offset = 0;
  return Array.from({ length: partCount }, (_, partIndex) => {
    const count = base + (partIndex < remainder ? 1 : 0);
    const part = segments.slice(offset, offset + count);
    offset += count;
    return part;
  });
}

const INVALID_FILENAME_PREFIX = /[<>:"/\\|?*\u0000-\u001f]/;

// #WDD-gpt 2026-09-20 - 分段 4CGS 使用用户前缀加固定四位一基序号，避免输出数量改变时文件排序规则漂移。
export function defaultFourCgsFilenamePrefix(sceneName: string): string {
  const stem = sceneName.trim().replace(/\.(?:4cgs|4gs|raw4d|ply4)$/i, '');
  const sanitized = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120);
  return sanitized || 'dong-editor-3';
}

export function isValidFourCgsFilenamePrefix(prefix: string): boolean {
  const trimmed = prefix.trim();
  return trimmed.length > 0
    && trimmed.length <= 120
    && trimmed !== '.'
    && trimmed !== '..'
    && !INVALID_FILENAME_PREFIX.test(trimmed)
    && !trimmed.endsWith('.');
}

export function fourCgsPartFilename(prefix: string, partIndex: number, partCount: number): string {
  const trimmedPrefix = prefix.trim();
  if (!isValidFourCgsFilenamePrefix(trimmedPrefix)) throw new Error('4CGS 文件名前缀无效。');
  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > 9_999) throw new Error(`4CGS 输出部分数无效：${partCount}。`);
  if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= partCount) throw new Error(`4CGS 输出部分序号无效：${partIndex}。`);
  if (partCount === 1) return `${trimmedPrefix}.4cgs`;
  return `${trimmedPrefix}_${String(partIndex + 1).padStart(4, '0')}.4cgs`;
}
