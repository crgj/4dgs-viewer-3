import {
  Application,
  Entity,
  Vec3,
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
import { Raw4DResource } from './Raw4DResource';

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
  setFrame(frame: number): void;
  dispose(): void;
}

export async function createRaw4DGaussian(
  app: Application,
  asset: Raw4DAsset,
  gpuPool: GpuBufferPool,
): Promise<Raw4DGaussian> {
  const canonical = new Raw4DCanonicalDataset(asset);
  const edits = new GaussianEditStore(asset.splatCount, canonical.pageSize);
  const sampler = app.graphicsDevice.isWebGPU ? null : new Raw4DFrameSampler(asset);
  const resource = new Raw4DResource(app.graphicsDevice, asset);
  if (sampler) resource.centers = sampler.gsplatData.getCenters();
  resource.aabb.setMinMax(new Vec3(...asset.bounds.min), new Vec3(...asset.bounds.max));

  const entity = new Entity(asset.sourceName.replace(/\.[^.]+$/, ''));
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
  return {
    entity,
    canonical,
    edits,
    bounds: asset.bounds,
    splatCount: asset.splatCount,
    totalFrames: asset.totalFrames,
    gpuBackend: gpuPlayback.backend,
    externalGpuByteSize: resource.gpuByteSize + gpuPlayback.externalGpuByteSize,
    deleteStableIds: (stableIds, deleted = true) => edits.setDeleted(stableIds, deleted),
    selectStableIds: (stableIds, mode = 'replace') => edits.select(stableIds, mode),
    defineAttribute: (definition) => edits.defineAttribute(definition),
    setAttribute: (name, stableId, value) => edits.setAttribute(name, stableId, value),
    setFrame: (frame: number) => {
      if (disposed) return;
      gpuPlayback.setFrame(frame);
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
