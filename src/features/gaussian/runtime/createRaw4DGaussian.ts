import { Raw4DPreparationClient } from './Raw4DPreparationClient';
import {
  Application,
  Entity,
  Vec3,
  WORKBUFFER_UPDATE_ONCE,
} from 'playcanvas';
import type { GaussianCanonicalDataset } from '../data/GaussianCanonicalDataset';
import {
  GaussianEditStore,
  type GaussianAttributeArray,
  type GaussianAttributeDefinition,
  type GaussianSelectionMode,
} from '../edit/GaussianEditStore';
import { Raw4DCanonicalDataset } from '../formats/raw4d/Raw4DCanonicalDataset';
import type { Raw4DAsset, Raw4DBounds } from '../formats/raw4d/Raw4DTypes';
import type { GpuBufferPool } from '../memory/GpuBufferPool';
import { Raw4DSortCenterSampler } from './Raw4DFrameSampler';
import { Raw4DGpuPlayback } from './Raw4DGpuPlayback';
import { createRaw4DGpuMemoryPlan } from './Raw4DGpuMemoryPlan';
import { Raw4DResource } from './Raw4DResource';
import { disposeGSplatAfterRendererSync } from './disposeGSplatAfterRendererSync';

const PREFETCH_GPU_WORK_BYTES_PER_SPLAT = 192;

export interface Raw4DGaussianCreateOptions {
  readonly enabled?: boolean;
  readonly backgroundPreparation?: boolean;
  readonly signal?: AbortSignal;
  readonly edits?: GaussianEditStore;
  readonly maxShBands?: number;
  readonly releaseTextureUploadSources?: boolean;
  readonly streamTextureKeyframes?: boolean;
}

export function estimateRaw4DGaussianGpuWorkBytes(asset: Raw4DAsset): number {
  return asset.splatCount * PREFETCH_GPU_WORK_BYTES_PER_SPLAT;
}

export function estimateRaw4DGaussianResidentGpuBytes(
  asset: Raw4DAsset,
  maxShBands = asset.shBands,
): number {
  const plan = createRaw4DGpuMemoryPlan(asset);
  const residentShBands = Math.max(0, Math.min(asset.shBands, Math.round(maxShBands)));
  const shBytesPerTexel = residentShBands === 0 ? 0 : residentShBands === 1 ? 16 : residentShBands === 2 ? 36 : 64;
  const resourceBytes = asset.splatCount * (32 + shBytesPerTexel);
  const editMaskBytes = asset.splatCount * 2;
  const orderBytes = asset.splatCount * 4;
  return plan.totalBytes + resourceBytes + editMaskBytes + orderBytes;
}

// #WDD-gpt 2026-08-16 - 单段渲染峰值额外给 Sort/WorkBuffer 留出逐点余量。
export function estimateRaw4DGaussianGpuBytes(
  asset: Raw4DAsset,
  maxShBands = asset.shBands,
): number {
  return estimateRaw4DGaussianResidentGpuBytes(asset, maxShBands)
    + estimateRaw4DGaussianGpuWorkBytes(asset);
}

export interface Raw4DGaussian {
  readonly entity: Entity;
  readonly canonical: GaussianCanonicalDataset;
  readonly edits: GaussianEditStore;
  readonly bounds: Raw4DBounds;
  readonly splatCount: number;
  readonly totalFrames: number;
  readonly shBands: number;
  readonly gpuBackend: 'storage-buffer' | 'texture' | 'streaming-texture';
  readonly externalGpuByteSize: number;
  deleteStableIds(stableIds: readonly number[], deleted?: boolean): void;
  selectStableIds(stableIds: readonly number[], mode?: GaussianSelectionMode): void;
  defineAttribute(definition: GaussianAttributeDefinition): void;
  setAttribute(name: string, stableId: number, value: number | readonly number[]): void;
  setDenseAttributeValues(name: string, values: GaussianAttributeArray): void;
  setAllMode(enabled: boolean): void;
  setShBands(level: number): number;
  refreshSourceData(): Promise<void>;
  /** 强制排序路径：只上传数据并刷新排序中心，不切换显示帧。返回钳制后的帧号。 */
  prepareFrame(frame: number): number;
  /** 强制排序路径：排序提交后切换显示帧 uniform。 */
  revealFrame(frame: number): void;
  setFrame(frame: number): void;
  dispose(): void;
}

export async function createRaw4DGaussian(
  app: Application,
  asset: Raw4DAsset,
  gpuPool: GpuBufferPool,
  options: Raw4DGaussianCreateOptions = {},
): Promise<Raw4DGaussian> {
  const prepStarted = performance.now();
  const canonical = new Raw4DCanonicalDataset(asset);
  // #WDD-gpt 2026-08-16 - 多片段序列注入持久编辑位集，GPU 实体重建时继续使用原选择和删除状态。
  const edits = options.edits ?? new GaussianEditStore(asset.splatCount, canonical.pageSize);
  if (edits.pointCount !== asset.splatCount) {
    throw new Error(`Gaussian edit store point count ${edits.pointCount} does not match asset ${asset.splatCount}.`);
  }
  let sampler = app.graphicsDevice.isWebGPU ? null : new Raw4DSortCenterSampler(asset);
  // #WDD-gpt 2026-09-07 - 长序列可只建立 SH2 GPU 资源，但 canonical 仍保留源 SH3 以供编辑与导出。
  const resource = new Raw4DResource(
    app.graphicsDevice,
    asset,
    options.maxShBands,
    options.releaseTextureUploadSources,
    Boolean(options.backgroundPreparation),
  );
  const preparation = options.backgroundPreparation ? new Raw4DPreparationClient(options.signal) : undefined;
  if (preparation) {
    try { await resource.prepareInWorker(preparation); }
    catch (error) { preparation.close(); resource.destroy(); throw error; }
  }
  const resourceReady = performance.now();
  if (sampler) resource.centers = sampler.centers;
  resource.aabb.setMinMax(new Vec3(...asset.bounds.min), new Vec3(...asset.bounds.max));

  const entity = new Entity(asset.sourceName.replace(/\.[^.]+$/, ''));
  entity.enabled = options.enabled ?? true;
  entity.addComponent('gsplat');
  entity.gsplat!.resource = resource;
  app.root.addChild(entity);
  let gpuPlayback: Raw4DGpuPlayback;
  try {
    gpuPlayback = await Raw4DGpuPlayback.create(
      entity,
      resource,
      sampler,
      asset,
      edits,
      app.graphicsDevice,
      gpuPool,
      {
        preparation,
        releaseTextureUploadSources: options.releaseTextureUploadSources,
        streamTextureKeyframes: options.streamTextureKeyframes,
      },
    );
  } catch (error) {
    // #WDD-gpt 2026-08-25 - 异步创建失败也可能已有 GSplatWorld 快照，禁止同步销毁 placement 形成 resource=null 的悬空窗口。
    disposeGSplatAfterRendererSync(app, entity, () => {
      entity.destroy();
      resource.destroy();
    });
    throw error;
  } finally { preparation?.close(); }

  // #WDD-gpt 2026-09-20 - 区分初始资源与时序 GPU 缓冲准备耗时，用完整读取目标审计瓶颈。
  if (options.backgroundPreparation) console.info(`RAW4D GPU prepare ${JSON.stringify({ backend: app.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl', points: asset.splatCount, resourceMs: resourceReady - prepStarted, temporalMs: performance.now() - resourceReady })}`);
  let disposed = false;
  let currentFrame = 0;
  return {
    entity,
    canonical,
    edits,
    bounds: asset.bounds,
    splatCount: asset.splatCount,
    totalFrames: asset.totalFrames,
    shBands: resource.shBands,
    get gpuBackend() { return gpuPlayback.backend; },
    get externalGpuByteSize() { return resource.gpuByteSize + gpuPlayback.externalGpuByteSize; },
    deleteStableIds: (stableIds, deleted = true) => edits.setDeleted(stableIds, deleted),
    selectStableIds: (stableIds, mode = 'replace') => edits.select(stableIds, mode),
    defineAttribute: (definition) => edits.defineAttribute(definition),
    setAttribute: (name, stableId, value) => edits.setAttribute(name, stableId, value),
    setDenseAttributeValues: (name, values) => edits.setDenseAttributeValues(name, values),
    setAllMode: (enabled) => gpuPlayback.setAllMode(enabled),
    setShBands: (level) => {
      const next = resource.setDisplayShBands(level);
      if (entity.gsplat) entity.gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
      return next;
    },
    setFrame: (frame: number) => {
      if (disposed) return;
      currentFrame = frame;
      gpuPlayback.setFrame(frame);
    },
    prepareFrame: (frame: number) => {
      currentFrame = frame;
      return gpuPlayback.prepareFrame(frame);
    },
    revealFrame: (frame: number) => {
      currentFrame = frame;
      gpuPlayback.revealFrame(frame);
    },
    refreshSourceData: async () => {
      if (disposed) return;
      resource.refreshSourceData();
      gpuPlayback.destroy();
      // #WDD-gpt 2026-08-17 - Canonical 关键帧整体改写后重建 CPU Sampler，刷新 SLERP 对与静态 SH 视图，禁止继续复用旧旋转缓存。
      if (!app.graphicsDevice.isWebGPU) {
        sampler = new Raw4DSortCenterSampler(asset);
        resource.centers = sampler.centers;
      }
      gpuPlayback = await Raw4DGpuPlayback.create(
        entity, resource, sampler, asset, edits, app.graphicsDevice, gpuPool,
        {
          preparation,
        releaseTextureUploadSources: options.releaseTextureUploadSources,
          streamTextureKeyframes: options.streamTextureKeyframes,
        },
      );
      gpuPlayback.setFrame(currentFrame);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // #WDD-gpt 2026-08-25 - 先隐藏并让 PlayCanvas reconcile Layer，再释放 GPU/placement，避免 GSplatInfo 读取空 resource。
      disposeGSplatAfterRendererSync(app, entity, () => {
        gpuPlayback.destroy();
        entity.destroy();
        resource.destroy();
      });
    },
  };
}
