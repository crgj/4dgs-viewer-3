import {
  Application,
  type CameraComponent,
  Color,
  Entity,
  Gizmo,
  type Layer,
  SHADOWUPDATE_REALTIME,
  SHADOWUPDATE_THISFRAME,
  TransformGizmo,
  TranslateGizmo,
} from 'playcanvas';
import { GSplatRelighting } from 'playcanvas/scripts/esm/gsplat/gsplat-relighting.mjs';
import { setGaussianRelightingShader } from '../../features/gaussian/runtime/GaussianRenderMode';
import { GS2MeshSceneObject } from '../gs2mesh/GS2MeshSceneObject';
import {
  DEFAULT_RELIGHTING_SETTINGS,
  INITIAL_RELIGHTING_STATE,
  sanitizeRelightingLight,
  sanitizeRelightingSettings,
  type RelightingLight,
  type RelightingLightPatch,
  type RelightingSettings,
  type RelightingState,
} from './RelightingTypes';

interface RuntimeLight {
  spec: RelightingLight;
  readonly entity: Entity;
}

interface RelightingProjectionCamera {
  fov: number;
  nearClip: number;
  farClip: number;
  projection: number;
  horizontalFov: boolean;
  aspectRatioMode: number;
  aspectRatio: number;
}

// #WDD-gpt 2026-08-16 - The official relighting script only copies fov/clip values; mirror the complete projection so the offscreen mesh stays pixel-aligned with a horizontal-FOV editor camera.
export function syncRelightingCameraProjection(
  source: RelightingProjectionCamera,
  target: RelightingProjectionCamera,
): void {
  target.fov = source.fov;
  target.nearClip = source.nearClip;
  target.farClip = source.farClip;
  target.projection = source.projection;
  target.horizontalFov = source.horizontalFov;
  target.aspectRatioMode = source.aspectRatioMode;
  target.aspectRatio = source.aspectRatio;
}

function colorFromHex(value: string): Color {
  return new Color(
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  );
}

export class GaussianRelightingController {
  private readonly relighting: GSplatRelighting;
  private readonly lightGizmo: TranslateGizmo;
  private readonly lightGizmoLayer: Layer;
  private readonly relightingCamera: CameraComponent;
  private readonly projectionSync: { off(): void };
  private readonly lights = new Map<string, RuntimeLight>();
  private proxy: GS2MeshSceneObject | null = null;
  private enabled = false;
  private editing = false;
  private selectedLightId: string | null = null;
  private nextLightId = 1;
  private settings: RelightingSettings = DEFAULT_RELIGHTING_SETTINGS;

  constructor(
    private readonly app: Application,
    private readonly camera: Entity,
    private readonly setCameraInputEnabled: (enabled: boolean) => void,
    private readonly onStateChange?: (state: RelightingState) => void,
  ) {
    if (!camera.camera) throw new Error('重光照需要可用的主摄像机。');
    if (!camera.script) camera.addComponent('script');
    const relighting = camera.script!.create(GSplatRelighting, {
      properties: {
        ...DEFAULT_RELIGHTING_SETTINGS,
        layerName: 'Dong Gaussian Relighting',
        priority: -1,
      },
    }) as GSplatRelighting | null;
    if (!relighting?.layer) throw new Error('浏览器无法创建重光照离屏渲染层。');
    this.relighting = relighting;
    const relightingCameraEntity = camera.children.find((child) => child.name === 'RelightingCamera') as Entity | undefined;
    if (!relightingCameraEntity?.camera) throw new Error('浏览器无法创建重光照投影摄像机。');
    this.relightingCamera = relightingCameraEntity.camera;
    syncRelightingCameraProjection(camera.camera, this.relightingCamera);
    // #WDD-gpt 2026-08-16 - Synchronize after PlayCanvas updates both render-target aspect ratios and before either camera renders.
    this.projectionSync = app.on('prerender', () => {
      if (camera.camera) syncRelightingCameraProjection(camera.camera, this.relightingCamera);
    });

    this.lightGizmoLayer = Gizmo.createLayer(app, 'Relighting Light Gizmo');
    this.lightGizmo = new TranslateGizmo(camera.camera, this.lightGizmoLayer);
    this.lightGizmo.size = 0.72;
    this.lightGizmo.on(TransformGizmo.EVENT_TRANSFORMSTART, () => {
      this.setCameraInputEnabled(false);
      const light = this.selectedRuntimeLight()?.entity.light;
      if (light) light.shadowUpdateMode = SHADOWUPDATE_REALTIME;
    });
    this.lightGizmo.on(TransformGizmo.EVENT_TRANSFORMMOVE, () => this.publishSelectedPosition());
    this.lightGizmo.on(TransformGizmo.EVENT_TRANSFORMEND, () => {
      this.publishSelectedPosition();
      const light = this.selectedRuntimeLight()?.entity.light;
      if (light) light.shadowUpdateMode = SHADOWUPDATE_THISFRAME;
      this.setCameraInputEnabled(true);
    });

    // #WDD-gpt 2026-08-15 - 官方脚本负责离屏纹理生命周期，合成 shader 由编辑器统一接管以兼容点/椭圆显示模式。
    this.relighting.enabled = false;
    setGaussianRelightingShader(this.app, false);
  }

  getState(): RelightingState {
    return {
      ...this.settings,
      enabled: this.enabled,
      selectedLightId: this.selectedLightId,
      lights: [...this.lights.values()].map(({ spec }) => ({ ...spec, position: [...spec.position] as [number, number, number] })),
    };
  }

  setProxy(proxy: GS2MeshSceneObject | null): void {
    if (this.proxy === proxy) return;
    this.proxy?.removeRelightingProxy();
    this.proxy = proxy;
    if (!proxy) {
      this.applyEnabled(false);
      this.emit();
      return;
    }
    proxy.installRelightingProxy(
      this.app,
      this.relighting.layer!.id,
      (material) => this.relighting.configureMaterial(material),
    );
    proxy.setRelightingProxyEnabled(this.enabled);
  }

  setEnabled(enabled: boolean): RelightingState {
    if (enabled && !this.proxy) throw new Error('请先用 GS2Mesh 生成当前帧 Mesh。');
    if (enabled && this.lights.size === 0) this.addLight();
    this.applyEnabled(enabled);
    this.emit();
    return this.getState();
  }

  setEditing(editing: boolean): RelightingState {
    this.editing = editing;
    this.updateGizmoAttachment();
    return this.getState();
  }

  setSelectedLight(id: string | null): RelightingState {
    this.selectedLightId = id && this.lights.has(id) ? id : null;
    this.updateGizmoAttachment();
    this.emit();
    return this.getState();
  }

  addLight(): RelightingState {
    if (!this.proxy) throw new Error('请先用 GS2Mesh 生成当前帧 Mesh。');
    if (this.lights.size >= 8) throw new Error('为控制实时阴影开销，最多可添加 8 个点光源。');
    const placement = this.proxy.getRelightingPlacement();
    const ordinal = this.nextLightId++;
    const angle = (ordinal - 1) * Math.PI * 0.72;
    const radius = placement.radius;
    const id = `relight-${ordinal}`;
    const spec = sanitizeRelightingLight({
      id,
      name: `Point ${ordinal}`,
      position: [
        placement.center[0] + Math.cos(angle) * radius * 1.45,
        placement.center[1] + radius * 1.2,
        placement.center[2] + Math.sin(angle) * radius * 1.45,
      ],
      color: ordinal % 2 === 0 ? '#a9cfff' : '#ffd7aa',
      intensity: 1.5,
      range: radius * 4,
      castShadows: true,
    }, radius * 4);
    const entity = this.createLightEntity(spec);
    this.lights.set(id, { spec, entity });
    this.selectedLightId = id;
    this.updateGizmoAttachment();
    this.emit();
    return this.getState();
  }

  removeLight(id: string): RelightingState {
    const runtime = this.lights.get(id);
    if (!runtime) return this.getState();
    runtime.entity.destroy();
    this.lights.delete(id);
    if (this.selectedLightId === id) this.selectedLightId = this.lights.keys().next().value ?? null;
    this.updateGizmoAttachment();
    this.emit();
    return this.getState();
  }

  updateLight(id: string, patch: RelightingLightPatch): RelightingState {
    const runtime = this.lights.get(id);
    if (!runtime) return this.getState();
    const fallbackRange = this.proxy?.getRelightingPlacement().radius ?? runtime.spec.range / 4;
    runtime.spec = sanitizeRelightingLight({ ...runtime.spec, ...patch }, fallbackRange * 4);
    this.applyLight(runtime);
    if (id === this.selectedLightId) this.lightGizmo.update();
    this.emit();
    return this.getState();
  }

  updateSettings(patch: Partial<RelightingSettings>): RelightingState {
    this.settings = sanitizeRelightingSettings({ ...this.settings, ...patch });
    this.relighting.blend = this.settings.blend;
    this.relighting.brightness = this.settings.brightness;
    this.relighting.background = this.settings.background;
    this.relighting.textureScale = this.settings.textureScale;
    this.emit();
    return this.getState();
  }

  destroy(): void {
    this.projectionSync.off();
    this.setCameraInputEnabled(true);
    this.lightGizmo.detach();
    this.lightGizmo.destroy();
    if (this.camera.camera) {
      this.camera.camera.layers = this.camera.camera.layers.filter((id) => id !== this.lightGizmoLayer.id);
    }
    this.app.scene.layers.remove(this.lightGizmoLayer);
    this.proxy?.removeRelightingProxy();
    this.proxy = null;
    this.lights.forEach(({ entity }) => entity.destroy());
    this.lights.clear();
    this.camera.script?.destroy('gsplatRelighting');
    setGaussianRelightingShader(this.app, false);
  }

  private createLightEntity(spec: RelightingLight): Entity {
    const entity = new Entity(`Relighting · ${spec.name}`);
    entity.addComponent('light', {
      type: 'omni',
      layers: [this.relighting.layer!.id],
      castShadows: spec.castShadows,
      shadowResolution: 1024,
      shadowBias: 0.12,
      normalOffsetBias: 0.025,
    });
    this.app.root.addChild(entity);
    const runtime = { spec, entity };
    this.applyLight(runtime);
    entity.enabled = this.enabled;
    return entity;
  }

  private applyLight(runtime: RuntimeLight): void {
    const { entity, spec } = runtime;
    entity.setPosition(...spec.position);
    if (!entity.light) return;
    entity.light.color = colorFromHex(spec.color);
    entity.light.intensity = spec.intensity;
    entity.light.range = spec.range;
    entity.light.castShadows = spec.castShadows;
    entity.light.shadowUpdateMode = SHADOWUPDATE_THISFRAME;
  }

  private applyEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.proxy?.setRelightingProxyEnabled(enabled);
    this.lights.forEach(({ entity }) => { entity.enabled = enabled; });
    this.relighting.enabled = enabled;
    setGaussianRelightingShader(this.app, enabled);
    this.updateGizmoAttachment();
  }

  private selectedRuntimeLight(): RuntimeLight | null {
    return this.selectedLightId ? this.lights.get(this.selectedLightId) ?? null : null;
  }

  private updateGizmoAttachment(): void {
    const selected = this.selectedRuntimeLight();
    if (this.enabled && this.editing && selected) this.lightGizmo.attach([selected.entity]);
    else this.lightGizmo.detach();
  }

  private publishSelectedPosition(): void {
    const runtime = this.selectedRuntimeLight();
    if (!runtime) return;
    const position = runtime.entity.getPosition();
    runtime.spec = {
      ...runtime.spec,
      position: [position.x, position.y, position.z],
    };
    this.emit();
  }

  private emit(): void {
    this.onStateChange?.(this.getState());
  }
}

export function emptyRelightingState(): RelightingState {
  return { ...INITIAL_RELIGHTING_STATE };
}
