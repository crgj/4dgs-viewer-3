import { open, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseRaw4D } from '../../features/gaussian/formats/raw4d/Raw4DParser';
import type { Raw4DSource } from '../../features/gaussian/formats/raw4d/Raw4DTypes';
import { findCompletelyInvisibleStableIds, inspectGaussianModel } from './ModelHealth';

const sourcePath = process.env.MODEL_HEALTH_TEST_FILE;

// #WDD-gpt 2026-08-17 - 可选真实文件验收直接验证安全候选来自原始全关键帧证据，不依赖 ALL 屏幕颜色或渲染阈值。
describe.skipIf(!sourcePath)('model health real-file safety', () => {
  it('classifies only exact all-key negative-infinity opacity as deletable', async () => {
    const sourceStats = await stat(sourcePath!);
    const handle = await open(sourcePath!, 'r');
    const source: Raw4DSource = {
      size: sourceStats.size,
      slice(start = 0, end = sourceStats.size) {
        return {
          async arrayBuffer() {
            const bytes = new Uint8Array(Math.max(0, end - start));
            await handle.read(bytes, 0, bytes.length, start);
            return bytes.buffer;
          },
        } as Blob;
      },
    };
    try {
      const asset = await parseRaw4D(source, { sourceName: sourcePath!, chunkRows: 16_384 });
      const candidates = findCompletelyInvisibleStableIds(asset);
      const report = inspectGaussianModel(asset);
      expect(report.safeDeletionCandidates).toBe(candidates.length);
      expect(report.fixedValues).toBe(0);
      process.stdout.write(`${JSON.stringify({
        source: sourcePath,
        splatCount: asset.splatCount,
        opacityKeyframes: asset.opacity.keyframes.length,
        safeDeletionCandidates: candidates.length,
        issueCounts: Object.fromEntries(report.issues.map((issue) => [issue.code, issue.count])),
      })}\n`);
    } finally {
      await handle.close();
    }
  }, 120_000);
});
