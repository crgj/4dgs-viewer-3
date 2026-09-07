import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExportCenterDialog } from './ExportCenterDialog';
import { supportsFourCgsSceneExport, supportsRaw4DSceneExport } from './ExportCenterModel';

describe('ExportCenterDialog', () => {
  it('offers .4CGS, segmented .RAW4D, and PLY sequence for an imported PLY4 scene', () => {
    const markup = renderToStaticMarkup(createElement(ExportCenterDialog, {
      deletedCount: 0,
      format: 'PLY4',
      frameCount: 150,
      inputBytes: 241_446_351,
      language: 'zh',
      onClose: vi.fn(),
      onExport: vi.fn(),
      sceneName: 'sample',
      segmentCount: 2,
      segments: [
        { name: 'segment_0_30.ply4', firstFrame: 0, lastFrame: 30 },
        { name: 'segment_30_60.ply4', firstFrame: 30, lastFrame: 60 },
      ],
    }));

    expect(supportsFourCgsSceneExport('PLY4')).toBe(true);
    expect(supportsRaw4DSceneExport('RAW4D')).toBe(true);
    expect(supportsFourCgsSceneExport('4GS')).toBe(true);
    expect(markup.match(/role="radio"/g)).toHaveLength(3);
    expect(markup).toContain('.4CGS');
    expect(markup).toContain('.RAW4D');
    expect(markup).toContain('PLY 序列');
    expect(markup).toContain('从 PLY4 编码完整场景与全部片段');
    expect(markup).toContain('Float32 输入会在 Worker 编码副本中量化为 FP16');
    expect(markup).toContain('场景内存保持 Float32，不会被原地改写');
    expect(markup).toContain('保持原始分段，写入 2 个独立 .raw4d 文件');
    expect(markup).not.toContain('当前 Mesh');
  });

  it('shows source filenames and frame ranges when RAW4D is selected', () => {
    const markup = renderToStaticMarkup(createElement(ExportCenterDialog, {
      deletedCount: 12,
      format: 'RAW4D',
      frameCount: 61,
      inputBytes: 200_000_000,
      language: 'zh',
      onClose: vi.fn(),
      onExport: vi.fn(),
      sceneName: 'RAW4D × 2',
      segmentCount: 2,
      segments: [
        { name: 'segment_0_30.raw4d', firstFrame: 0, lastFrame: 30 },
        { name: 'segment_30_60.raw4d', firstFrame: 30, lastFrame: 60 },
      ],
    }));

    expect(markup).toContain('2 × .raw4d');
    expect(markup).toContain('segment_0_30.raw4d');
    expect(markup).toContain('segment_30_60.raw4d');
    expect(markup).toContain('0–30');
    expect(markup).toContain('30–60');
    expect(markup).toContain('原片段帧范围和源精度保持不变');
  });
});
