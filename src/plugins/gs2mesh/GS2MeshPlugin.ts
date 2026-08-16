import { encodeGS2MeshPly } from './GS2MeshPly';
import type {
  GS2MeshData,
  GS2MeshHost,
  GS2MeshOptions,
  GS2MeshSceneStats,
  GS2MeshState,
  GS2MeshVector3,
} from './GS2MeshTypes';
import { GS2MeshOpacityWorkerClient } from './GS2MeshOpacityWorkerClient';

const BROWSER_BACKEND = 'Frontend Gaussian Opacity Field refinement + Marching Tetrahedra';

export class GS2MeshPlugin {
  private readonly worker = new GS2MeshOpacityWorkerClient();
  private running = false;
  private controller: AbortController | null = null;
  private lastPly: ArrayBuffer | null = null;
  private lastFrame = 0;

  async reconstruct(
    host: GS2MeshHost,
    options: GS2MeshOptions,
    onStateChange: (state: GS2MeshState) => void,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    let previewInstalled = false;
    let previewMesh: GS2MeshData | null = null;
    let previewStats: GS2MeshSceneStats | null = null;
    let previewBackend: string | undefined;
    let captureFrame: number | undefined;
    let captureGaussianCount: number | undefined;
    let captureFocus: GS2MeshVector3 | undefined;
    try {
      onStateChange({ stage: 'capturing', progress: 0.02, backend: BROWSER_BACKEND });
      const capture = await host.captureGS2MeshGaussians({
        ...options,
        signal: controller.signal,
        onProgress: (completed, total) => onStateChange({
          stage: 'capturing',
          progress: 0.04 + (completed / Math.max(1, total)) * 0.16,
          backend: BROWSER_BACKEND,
        }),
      });
      if (controller.signal.aborted) throw new DOMException('GS2Mesh reconstruction was cancelled.', 'AbortError');
      const gaussianCount = capture.positions.length / 3;
      captureFrame = capture.frame;
      captureGaussianCount = gaussianCount;
      captureFocus = capture.focus;

      onStateChange({
        stage: 'matching',
        progress: 0.21,
        frame: capture.frame,
        gaussianCount,
        focus: capture.focus,
        backend: BROWSER_BACKEND,
      });
      const reconstruction = await this.worker.reconstruct(capture, controller.signal, (stage, progress) => {
        onStateChange({
          stage,
          progress: stage === 'matching' ? 0.21 + progress * 0.49 : 0.7 + progress * 0.24,
          frame: capture.frame,
          gaussianCount,
          focus: capture.focus,
          backend: BROWSER_BACKEND,
          previewBackend,
        });
      }, (preview, backend, elapsedMs) => {
        if (controller.signal.aborted) return;
        previewMesh = preview;
        previewStats = host.installGS2Mesh(preview);
        previewInstalled = true;
        host.setGS2MeshVisible(true);
        previewBackend = `${backend} · ${(elapsedMs / 1000).toFixed(2)}s`;
        // #WDD-gpt 2026-08-15 - Show the loading-stage mesh immediately, then replace the same scene object after background refinement.
        onStateChange({
          stage: 'fusing',
          progress: 0.7,
          frame: capture.frame,
          gaussianCount,
          vertexCount: previewStats.vertexCount,
          triangleCount: previewStats.triangleCount,
          focus: capture.focus,
          backend: BROWSER_BACKEND,
          previewBackend,
        });
      });
      const { mesh, backend: finalBackend } = reconstruction;

      onStateChange({
        stage: 'installing',
        progress: 0.95,
        frame: capture.frame,
        gaussianCount,
        focus: capture.focus,
        backend: finalBackend,
        previewBackend,
      });
      const stats = host.installGS2Mesh(mesh);
      previewInstalled = false;
      host.setGS2MeshVisible(true);
      this.lastPly = encodeGS2MeshPly(mesh);
      this.lastFrame = capture.frame;
      onStateChange({
        stage: 'success',
        progress: 1,
        frame: capture.frame,
        gaussianCount,
        vertexCount: stats.vertexCount,
        triangleCount: stats.triangleCount,
        focus: capture.focus,
        backend: finalBackend,
        previewBackend,
      });
    } catch (error) {
      // #WDD-gpt 2026-08-15 - Preserve callback-owned preview state with explicit types because control-flow analysis cannot see asynchronous assignments.
      const retainedPreview = previewMesh as GS2MeshData | null;
      const retainedStats = previewStats as GS2MeshSceneStats | null;
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (previewInstalled) host.clearGS2Mesh();
        onStateChange({ stage: 'cancelled', progress: 0 });
      } else if (previewInstalled && retainedPreview && retainedStats) {
        const reason = error instanceof Error ? error.message : String(error);
        // #WDD-gpt 2026-08-15 - A completed preview is a valid browser-only mesh; retain and export it while clearly labeling that metric refinement did not finish.
        this.lastPly = encodeGS2MeshPly(retainedPreview);
        this.lastFrame = captureFrame ?? 0;
        host.setGS2MeshVisible(true);
        onStateChange({
          stage: 'success',
          progress: 1,
          frame: captureFrame,
          gaussianCount: captureGaussianCount,
          vertexCount: retainedStats.vertexCount,
          triangleCount: retainedStats.triangleCount,
          focus: captureFocus,
          backend: '128³ 快速预览保底（精细重建未完成）',
          previewBackend,
          warning: `精细重建未完成，已保留可导出、可重光照的快速预览。${reason}`,
        });
        previewInstalled = false;
      } else {
        if (previewInstalled) host.clearGS2Mesh();
        onStateChange({
          stage: 'error',
          progress: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      this.running = false;
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.worker.cancel();
  }

  clear(host: GS2MeshHost, onStateChange: (state: GS2MeshState) => void): void {
    this.cancel();
    host.clearGS2Mesh();
    this.lastPly = null;
    onStateChange({ stage: 'idle', progress: 0 });
  }

  exportLastResult(): void {
    if (!this.lastPly) return;
    const url = URL.createObjectURL(new Blob([this.lastPly], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gs2mesh_frame_${this.lastFrame.toString().padStart(4, '0')}.ply`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  get canExport(): boolean {
    return this.lastPly !== null;
  }

  dispose(): void {
    this.controller?.abort();
    this.worker.dispose();
    this.lastPly = null;
  }
}
