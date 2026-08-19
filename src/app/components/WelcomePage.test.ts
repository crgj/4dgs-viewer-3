import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WelcomePage, wrapGalleryIndex } from './WelcomePage';

describe('WelcomePage', () => {
  it('keeps import, gallery, recovery and hardware guidance in the simplified welcome page', () => {
    const markup = renderToStaticMarkup(createElement(WelcomePage, {
      language: 'zh',
      onBrowse: vi.fn(),
      onOpenGallery: vi.fn(),
      recoverySources: ['scene.4cgs'],
    }));

    expect(markup).toContain('重新选择文件并恢复');
    expect(markup).toContain('浏览测试相册');
    expect(markup).toContain('scene.4cgs');
    expect(markup).toContain('内存为设备提示');
    expect(markup).toContain('.4cgs · .raw4d · .ply4 · .sog · .ply');
  });

  it('wraps gallery paging in both directions', () => {
    expect(wrapGalleryIndex(2, 2)).toBe(0);
    expect(wrapGalleryIndex(-1, 2)).toBe(1);
    expect(wrapGalleryIndex(3, 0)).toBe(0);
  });
});
