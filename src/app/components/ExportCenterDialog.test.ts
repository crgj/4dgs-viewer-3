import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExportCenterDialog } from './ExportCenterDialog';
import { supportsFourCgsSceneExport } from './ExportCenterModel';

describe('ExportCenterDialog', () => {
  it('offers only .4CGS and PLY sequence for an imported PLY4 scene', () => {
    const markup = renderToStaticMarkup(createElement(ExportCenterDialog, {
      deletedCount: 0,
      format: 'PLY4',
      frameCount: 150,
      inputBytes: 241_446_351,
      language: 'zh',
      onClose: vi.fn(),
      onExport: vi.fn(),
      sceneName: 'sample',
      segmentCount: 1,
    }));

    expect(supportsFourCgsSceneExport('PLY4')).toBe(true);
    expect(supportsFourCgsSceneExport('4GS')).toBe(true);
    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup).toContain('.4CGS');
    expect(markup).toContain('PLY 序列');
    expect(markup).toContain('从 PLY4 编码完整场景与全部片段');
    expect(markup).toContain('Float32 输入会在 Worker 编码副本中量化为 FP16');
    expect(markup).toContain('场景内存保持 Float32，不会被原地改写');
    expect(markup).not.toContain('当前 Mesh');
  });
});
