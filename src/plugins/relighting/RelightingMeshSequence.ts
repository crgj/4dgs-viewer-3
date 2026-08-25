// #WDD-gpt 2026-08-21 - 重光照逐帧 Mesh 使用每帧原始激活 Gaussian 独立重建；不再跨帧平均位置、尺度、旋转或透明度。
import { GS2MeshOpacityWorkerClient } from '../gs2mesh/GS2MeshOpacityWorkerClient';
import type { GS2MeshData, GS2MeshGaussianFieldInput, GS2MeshSceneStats } from '../gs2mesh/GS2MeshTypes';
import type {
  RelightingMeshCaptureOptions,
  RelightingMeshFrameVisitor,
} from './RelightingMeshCaptureTypes';

export interface RelightingMeshHost {
  streamRelightingMeshFrames(
    options: RelightingMeshCaptureOptions,
    visitor: RelightingMeshFrameVisitor,
  ): Promise<void>;
  installRelightingMesh(data: GS2MeshData): GS2MeshSceneStats;
  updateGS2MeshGeometry(data: GS2MeshData): GS2MeshSceneStats | null;
  clearGS2Mesh(): void;
}

export type RelightingMeshStage = 'idle' | 'capturing' | 'rebuilding' | 'success' | 'cancelled' | 'error';

export interface RelightingMeshState {
  readonly stage: RelightingMeshStage;
  readonly progress: number;
  readonly currentFrame?: number;
  readonly frameCount?: number;
  readonly gaussianCount?: number;
  readonly vertexCount?: number;
  readonly triangleCount?: number;
  readonly frameMs?: number;
  readonly backend?: string;
  readonly error?: string;
}

export const INITIAL_RELIGHTING_MESH_STATE: RelightingMeshState = { stage: 'idle', progress: 0 };

export interface RelightingMeshOptions {
  /** 统一时间轴帧号，inclusive。 */
  readonly frameStart: number;
  /** inclusive */
  readonly frameEnd: number;
  readonly maxGaussians: number;
  readonly fieldResolution: number;
  readonly isoLevel: number;
}

export type RelightingMeshWorker = Pick<GS2MeshOpacityWorkerClient, 'reconstruct' | 'cancel' | 'dispose'>;

export class RelightingMeshSequence {
  private readonly worker: RelightingMeshWorker;
  private running = false;
  private controller: AbortController | null = null;
  private frameMeshes: GS2MeshData[] = [];
  private frameIndices: number[] = [];
  private shownMeshFrame = -1;

  constructor(worker: RelightingMeshWorker = new GS2MeshOpacityWorkerClient()) {
    this.worker = worker;
  }

  get isReady(): boolean {
    return this.frameMeshes.length > 0;
  }

  async generate(
    host: RelightingMeshHost,
    options: RelightingMeshOptions,
    onStateChange: (state: RelightingMeshState) => void,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.frameMeshes = [];
    this.frameIndices = [];
    this.shownMeshFrame = -1;
    const controller = new AbortController();
    this.controller = controller;
    const totalFrames = Math.max(1, options.frameEnd - options.frameStart + 1);
    let vertexCount = 0;
    let triangleCount = 0;
    let gaussianCount = 0;
    let frameMs = 0;
    let backend = '';
    try {
      host.clearGS2Mesh();
      onStateChange({ stage: 'capturing', progress: 0.01, frameCount: totalFrames });
      await host.streamRelightingMeshFrames({
        frameStart: options.frameStart,
        frameEnd: options.frameEnd,
        maxGaussians: options.maxGaussians,
        fieldResolution: options.fieldResolution,
        isoLevel: options.isoLevel,
        viewCount: 8,
        sceneUnitMillimeters: 1000,
        targetVoxelMillimeters: 2,
        smoothingIterations: 0,
        signal: controller.signal,
        onProgress: (completed, count) => onStateChange({
          stage: 'capturing',
          progress: Math.min(0.98, completed / Math.max(1, count)),
          frameCount: count,
          currentFrame: options.frameStart + Math.max(0, completed - 1),
        }),
      }, async (input: GS2MeshGaussianFieldInput, completed, count) => {
        if (controller.signal.aborted) throw new DOMException('逐帧网格生成已取消。', 'AbortError');
        const startedAt = performance.now();
        // #WDD-gpt 2026-08-21 - Worker 会转移输入 TypedArray 的 ArrayBuffer；重建返回后长度已变成 0，必须在提交前记录真实 GS 数量。
        const inputGaussianCount = input.positions.length / 3;
        onStateChange({
          stage: 'rebuilding',
          progress: Math.max(0.01, (completed - 1) / Math.max(1, count)),
          currentFrame: input.frame,
          frameCount: count,
          gaussianCount: inputGaussianCount,
        });
        const reconstruction = await this.worker.reconstruct(
          input,
          controller.signal,
          () => undefined,
          () => undefined,
          { perFrameDenseOnly: true },
        );
        const mesh = reconstruction.mesh;
        this.frameMeshes.push(mesh);
        this.frameIndices.push(input.frame);
        this.shownMeshFrame = input.frame;
        const stats = this.frameMeshes.length === 1
          ? host.installRelightingMesh(mesh)
          : host.updateGS2MeshGeometry(mesh);
        gaussianCount = inputGaussianCount;
        vertexCount = stats?.vertexCount ?? mesh.positions.length / 3;
        triangleCount = stats?.triangleCount ?? mesh.indices.length / 3;
        frameMs = performance.now() - startedAt;
        backend = reconstruction.backend;
        onStateChange({
          stage: 'rebuilding',
          progress: completed / Math.max(1, count),
          currentFrame: input.frame,
          frameCount: count,
          gaussianCount,
          vertexCount,
          triangleCount,
          frameMs,
          backend,
        });
      });
      onStateChange({
        stage: 'success',
        progress: 1,
        currentFrame: this.frameIndices.at(-1),
        frameCount: this.frameMeshes.length,
        gaussianCount,
        vertexCount,
        triangleCount,
        frameMs,
        backend,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        onStateChange({ stage: 'cancelled', progress: 0 });
      } else {
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

  showFrame(host: RelightingMeshHost, frame: number): void {
    if (this.frameMeshes.length === 0) return;
    let best = 0;
    for (let index = 0; index < this.frameIndices.length; index += 1) {
      if (this.frameIndices[index] <= frame) best = index;
      else break;
    }
    if (this.frameIndices[best] === this.shownMeshFrame) return;
    this.shownMeshFrame = this.frameIndices[best];
    host.updateGS2MeshGeometry(this.frameMeshes[best]);
  }

  cancel(): void {
    this.controller?.abort();
    this.worker.cancel();
  }

  dispose(): void {
    this.controller?.abort();
    this.worker.dispose();
    this.frameMeshes = [];
    this.frameIndices = [];
    this.shownMeshFrame = -1;
  }
}
