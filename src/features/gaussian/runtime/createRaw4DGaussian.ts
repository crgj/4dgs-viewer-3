import {
  Application,
  Entity,
  Vec3,
  WORKBUFFER_UPDATE_ONCE,
} from 'playcanvas';
import type { GaussianCanonicalDataset } from '../data/GaussianCanonicalDataset';
import {
  GaussianEditStore,
  type GaussianAttributeDefinition,
  type GaussianSelectionMode,
} from '../edit/GaussianEditStore';
import { Raw4DCanonicalDataset } from '../formats/raw4d/Raw4DCanonicalDataset';
import type { Raw4DAsset, Raw4DBounds } from '../formats/raw4d/Raw4DTypes';
import type { GpuBufferPool } from '../memory/GpuBufferPool';
import { Raw4DFrameSampler } from './Raw4DFrameSampler';
import { Raw4DGpuPlayback } from './Raw4DGpuPlayback';
import { createRaw4DGpuMemoryPlan } from './Raw4DGpuMemoryPlan';
import { Raw4DResource } from './Raw4DResource';

const PREFETCH_GPU_WORK_BYTES_PER_SPLAT = 192;

export interface Raw4DGaussianCreateOptions {
  readonly enabled?: boolean;
  readonly edits?: GaussianEditStore;
}

// #WDD-gpt 2026-08-16 - 预取窗口按完整渲染峰值估算，而不是只统计显式纹理，给 Sort/WorkBuffer 留出逐点余量。
export function estimateRaw4DGaussianGpuBytes(asset: Raw4DAsset): number {
  const plan = createRaw4DGpuMemoryPlan(asset);
  const shBytesPerTexel = asset.shBands === 0 ? 0 : asset.shBands === 1 ? 16 : asset.shBands === 2 ? 36 : 64;
  const resourceBytes = asset.splatCount * (32 + shBytesPerTexel);
  const editMaskBytes = asset.splatCount * 2;
  return plan.totalBytes + resourceBytes + editMaskBytes
    + asset.splatCount * PREFETCH_GPU_WORK_BYTES_PER_SPLAT;
}

export interface Raw4DGaussian {
  readonly entity: Entity;
  readonly canonical: GaussianCanonicalDataset;
  readonly edits: GaussianEditStore;
  readonly bounds: Raw4DBounds;
  readonly splatCount: number;
  readonly totalFrames: number;
  readonly gpuBackend: 'storage-buffer' | 'texture';
  readonly externalGpuByteSize: number;
  deleteStableIds(stableIds: readonly number[], deleted?: boolean): void;
  selectStableIds(stableIds: readonly number[], mode?: GaussianSelectionMode): void;
  defineAttribute(definition: GaussianAttributeDefinition): void;
  setAttribute(name: string, stableId: number, value: number | readonly number[]): void;
  setAllMode(enabled: boolean): void;
  setShBands(level: number): number;
  refreshSourceData(): Promise<void>;
  setFrame(frame: number): void;
  dispose(): void;
}

export async function createRaw4DGaussian(
  app: Application,
  asset: Raw4DAsset,
  gpuPool: GpuBufferPool,
  options: Raw4DGaussianCreateOptions = {},
): Promise<Raw4DGaussian> {
  const canonical = new Raw4DCanonicalDataset(asset);
  // #WDD-gpt 2026-08-16 - 多片段序列注入持久编辑位集，GPU 实体重建时继续使用原选择和删除状态。
  const edits = options.edits ?? new GaussianEditStore(asset.splatCount, canonical.pageSize);
  if (edits.pointCount !== asset.splatCount) {
    throw new Error(`Gaussian edit store point count ${edits.pointCount} does not match asset ${asset.splatCount}.`);
  }
  let sampler = app.graphicsDevice.isWebGPU ? null : new Raw4DFrameSampler(asset);
  const resource = new Raw4DResource(app.graphicsDevice, asset);
  if (sampler) resource.centers = sampler.gsplatData.getCenters();
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
    );
  } catch (error) {
    entity.destroy();
    resource.destroy();
    throw error;
  }

  let disposed = false;
  let currentFrame = 0;
  return {
    entity,
    canonical,
    edits,
    bounds: asset.bounds,
    splatCount: asset.splatCount,
    totalFrames: asset.totalFrames,
    get gpuBackend() { return gpuPlayback.backend; },
    get externalGpuByteSize() { return resource.gpuByteSize + gpuPlayback.externalGpuByteSize; },
    deleteStableIds: (stableIds, deleted = true) => edits.setDeleted(stableIds, deleted),
    selectStableIds: (stableIds, mode = 'replace') => edits.select(stableIds, mode),
    defineAttribute: (definition) => edits.defineAttribute(definition),
    setAttribute: (name, stableId, value) => edits.setAttribute(name, stableId, value),
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
    refreshSourceData: async () => {
      if (disposed) return;
      resource.refreshSourceData();
      gpuPlayback.destroy();
      // #WDD-gpt 2026-08-17 - Canonical 关键帧整体改写后重建 CPU Sampler，刷新 SLERP 对与静态 SH 视图，禁止继续复用旧旋转缓存。
      if (!app.graphicsDevice.isWebGPU) {
        sampler = new Raw4DFrameSampler(asset);
        resource.centers = sampler.gsplatData.getCenters();
      }
      gpuPlayback = await Raw4DGpuPlayback.create(
        entity, resource, sampler, asset, edits, app.graphicsDevice, gpuPool,
      );
      gpuPlayback.setFrame(currentFrame);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      gpuPlayback.destroy();
      entity.destroy();
      resource.destroy();
    },
  };
}
