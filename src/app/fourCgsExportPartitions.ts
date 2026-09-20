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

export function fourCgsPartFilename(stem: string, partIndex: number, partCount: number): string {
  if (partCount === 1) return `${stem}.4cgs`;
  const width = Math.max(2, String(partCount).length);
  return `${stem}.part-${String(partIndex + 1).padStart(width, '0')}-of-${String(partCount).padStart(width, '0')}.4cgs`;
}
