import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SceneOutliner } from './SceneOutliner';

const camera = {
  distance: 4,
  pitch: -12,
  target: [0, 1, 0] as const,
  yaw: 24,
};

function renderBookmarks(bookmarks: readonly (typeof camera | null)[]): string {
  return renderToStaticMarkup(createElement(SceneOutliner, {
    cameraBookmarks: bookmarks,
    gaussianVisible: true,
    gs2MeshVisible: false,
    hasMesh: false,
    language: 'zh',
    lightCount: 0,
    onFocusScene: vi.fn(),
    onFocusSelection: vi.fn(),
    onFrameChange: vi.fn(),
    onGaussianVisibleChange: vi.fn(),
    onMeshVisibleChange: vi.fn(),
    onRecallBookmark: vi.fn(),
    onSaveBookmark: vi.fn(),
    onToggleAxes: vi.fn(),
    onToggleEnvelope: vi.fn(),
    onToggleGrid: vi.fn(),
    onToggleRuler: vi.fn(),
    recoverySources: [],
    sceneName: 'scene',
    showAxes: true,
    showEnvelope: false,
    showGrid: true,
    showRuler: false,
    status: { phase: 'ready', renderer: 'test', splatCount: 1 },
    workspaceSavedAt: null,
    workspaceState: 'saved',
  }));
}

describe('SceneOutliner camera bookmarks', () => {
  it('makes an empty numbered slot directly saveable', () => {
    const markup = renderBookmarks([null, null, null]);

    expect(markup).toContain('aria-label="保存视角 1"');
    expect(markup).toContain('<b>1</b><small>保存</small>');
    expect(markup).toContain('aria-label="覆盖保存视角 1" disabled=""');
  });

  it('labels a populated slot as recallable and enables overwrite', () => {
    const markup = renderBookmarks([camera, null, null]);

    expect(markup).toContain('class="saved"');
    expect(markup).toContain('aria-label="恢复视角 1"');
    expect(markup).toContain('<b>1</b><small>恢复</small>');
    expect(markup).toMatch(/aria-label="覆盖保存视角 1"(?! disabled)/);
  });
});
