import {
  Application,
  BLEND_NORMAL,
  Color,
  type Camera,
  type CameraComponent,
  Entity,
  type EventHandle,
  Layer,
  type Material,
  Mesh,
  MeshInstance,
  PRIMITIVE_LINES,
  type ShaderMaterial,
  SORTMODE_NONE,
  StandardMaterial,
} from 'playcanvas';
import type { GaussianCylinderSelectionRegion } from '../selection/GaussianCylinderSelection';

const AXIS_LENGTH_METERS = 1;
const UP_AXIS_LENGTH_METERS = 1.5;
const AXIS_SURFACE_OFFSET = 0.006;
const AXIS_THICKNESS_METERS = 0.015;
const GAUSSIAN_OCCLUSION_ALPHA_CLIP = 0.16;

// #WDD-gpt 2026-08-16 - 固定采用 DCC 常用的 X 红、Y 绿、Z 蓝，避免轴线在暗色视口中混成灰白色。
export const SCENE_AXIS_COLORS = {
  x: [255, 64, 72, 255],
  y: [66, 224, 112, 255],
  z: [64, 128, 255, 255],
} as const;

export const SCENE_AXIS_SEGMENTS = {
  x: { start: [0, AXIS_SURFACE_OFFSET, 0], end: [AXIS_LENGTH_METERS, AXIS_SURFACE_OFFSET, 0] },
  // #WDD-gpt 2026-08-16 - Y 轴从原点精确绘制到 1.5m，避免地面偏移导致实际长度缩短为 1.494m。
  y: { start: [0, 0, 0], end: [0, UP_AXIS_LENGTH_METERS, 0] },
  z: { start: [0, AXIS_SURFACE_OFFSET, 0], end: [0, AXIS_SURFACE_OFFSET, AXIS_LENGTH_METERS] },
} as const;

export const SCENE_AXIS_BARS = {
  x: {
    position: [AXIS_LENGTH_METERS * 0.5, AXIS_SURFACE_OFFSET, 0],
    scale: [AXIS_LENGTH_METERS, AXIS_THICKNESS_METERS, AXIS_THICKNESS_METERS],
  },
  y: {
    position: [0, UP_AXIS_LENGTH_METERS * 0.5, 0],
    scale: [AXIS_THICKNESS_METERS, UP_AXIS_LENGTH_METERS, AXIS_THICKNESS_METERS],
  },
  z: {
    position: [0, AXIS_SURFACE_OFFSET, AXIS_LENGTH_METERS * 0.5],
    scale: [AXIS_THICKNESS_METERS, AXIS_THICKNESS_METERS, AXIS_LENGTH_METERS],
  },
} as const;

interface DepthMaterialState {
  readonly alphaClipForward: number;
  readonly alphaWrite: boolean;
  readonly blueWrite: boolean;
  readonly depthWrite: boolean;
  readonly greenWrite: boolean;
  readonly material: Material;
  readonly redWrite: boolean;
}

function readNumberParameter(material: Material, name: string, fallback: number): number {
  const parameter = material.getParameter(name) as { data?: unknown } | undefined;
  return typeof parameter?.data === 'number' ? parameter.data : fallback;
}

export class SceneGuides {
  private readonly entity = new Entity('Grid & Axes');
  private readonly gridEntity = new Entity('Grid');
  private readonly fineGridEntity = new Entity('Fine Grid 0.5m');
  private readonly coarseGridEntity = new Entity('Coarse Grid 1m');
  private readonly axesEntity = new Entity('Axes');
  private readonly cylinderEntity = new Entity('Selection Cylinder');
  private readonly fineGridMesh: Mesh;
  private readonly coarseGridMesh: Mesh;
  private readonly material = new StandardMaterial();
  private readonly axisMaterials: StandardMaterial[] = [];
  private readonly cylinderMaterial = new StandardMaterial();
  private cylinderMesh: Mesh | null = null;
  private readonly depthLayer = new Layer({
    name: 'Gaussian Guide Depth',
    transparentSortMode: SORTMODE_NONE,
  });
  private readonly guideLayer = new Layer({
    name: 'Grid & Axes',
    transparentSortMode: SORTMODE_NONE,
  });
  private readonly cameraLayerIds: readonly number[];
  private readonly appUpdate: EventHandle;
  private readonly gsplatMaterialCreated: EventHandle | null;
  private readonly preRenderLayer: EventHandle;
  private readonly postRenderLayer: EventHandle;
  private depthProxy: MeshInstance | null = null;
  private depthMaterialState: DepthMaterialState | null = null;
  private gaussianDepthSourceEnabled = false;

  constructor(
    private readonly app: Application,
    private readonly camera: CameraComponent,
    size = 10,
    divisions = 20,
  ) {
    const fineGridPositions: number[] = [];
    const fineGridColors: number[] = [];
    const coarseGridPositions: number[] = [];
    const coarseGridColors: number[] = [];
    const half = size / 2;
    const step = size / divisions;
    const pushGridLine = (
      positions: number[],
      colors: number[],
      start: [number, number, number],
      end: [number, number, number],
      color: [number, number, number, number],
    ) => {
      positions.push(...start, ...end);
      colors.push(...color, ...color);
    };

    for (let i = 0; i <= divisions; i += 1) {
      const offset = -half + i * step;
      const isCoarseMeterLine = Math.abs(offset - Math.round(offset)) < 1e-6;
      const positions = isCoarseMeterLine ? coarseGridPositions : fineGridPositions;
      const colors = isCoarseMeterLine ? coarseGridColors : fineGridColors;
      const color: [number, number, number, number] = isCoarseMeterLine
        ? [62, 78, 104, 165]
        : [31, 39, 53, 72];

      // #WDD-gpt 2026-08-16 - 网格拆为 1m 粗层与 0.5m 细层，避免旧版 2.5m 主线误导场景尺度。
      pushGridLine(positions, colors, [-half, 0, offset], [half, 0, offset], color);
      pushGridLine(positions, colors, [offset, 0, -half], [offset, 0, half], color);
    }

    this.fineGridMesh = new Mesh(app.graphicsDevice);
    this.fineGridMesh.setPositions(fineGridPositions);
    this.fineGridMesh.setColors32(fineGridColors);
    this.fineGridMesh.update(PRIMITIVE_LINES);
    this.coarseGridMesh = new Mesh(app.graphicsDevice);
    this.coarseGridMesh.setPositions(coarseGridPositions);
    this.coarseGridMesh.setColors32(coarseGridColors);
    this.coarseGridMesh.update(PRIMITIVE_LINES);

    this.material.useLighting = false;
    // #WDD-gpt 2026-08-16 - 无光照材质以白色发光乘顶点色，保证 RGB 轴色不被默认白色漫反射覆盖。
    this.material.diffuse.set(0, 0, 0);
    this.material.emissive.set(1, 1, 1);
    this.material.emissiveVertexColor = true;
    this.material.opacityVertexColor = true;
    this.material.blendType = BLEND_NORMAL;
    this.material.depthTest = true;
    this.material.depthWrite = false;
    this.material.update();

    const fineGridInstance = new MeshInstance(this.fineGridMesh, this.material, this.fineGridEntity);
    const coarseGridInstance = new MeshInstance(this.coarseGridMesh, this.material, this.coarseGridEntity);
    fineGridInstance.castShadow = false; fineGridInstance.receiveShadow = false;
    coarseGridInstance.castShadow = false; coarseGridInstance.receiveShadow = false;

    const createAxisBar = (
      name: string,
      position: readonly [number, number, number],
      scale: readonly [number, number, number],
      color: readonly [number, number, number, number],
    ) => {
      const axis = new Entity(name);
      axis.addComponent('render', { type: 'box', layers: [this.guideLayer.id] });
      axis.setLocalPosition(...position);
      axis.setLocalScale(...scale);
      const material = new StandardMaterial();
      material.useLighting = false;
      material.diffuse.set(0, 0, 0);
      material.emissive.set(color[0] / 255, color[1] / 255, color[2] / 255);
      material.blendType = BLEND_NORMAL;
      material.depthTest = true;
      material.depthWrite = false;
      material.update();
      for (const meshInstance of axis.render!.meshInstances) {
        meshInstance.material = material;
        meshInstance.castShadow = false;
        meshInstance.receiveShadow = false;
      }
      this.axisMaterials.push(material);
      this.axesEntity.addChild(axis);
    };
    // #WDD-gpt 2026-08-16 - 改用真实三维轴杆，Y 杆中心 0.75m、整体高度 1.5m，避免线段端点与网格混淆。
    createAxisBar('Axis X · 1m', SCENE_AXIS_BARS.x.position, SCENE_AXIS_BARS.x.scale, SCENE_AXIS_COLORS.x);
    createAxisBar('Axis Y · 1.5m', SCENE_AXIS_BARS.y.position, SCENE_AXIS_BARS.y.scale, SCENE_AXIS_COLORS.y);
    createAxisBar('Axis Z · 1m', SCENE_AXIS_BARS.z.position, SCENE_AXIS_BARS.z.scale, SCENE_AXIS_COLORS.z);

    // #WDD-gpt  2026-08-15 - 彩色高斯保持标准透明混合；单独追加仅深度通道后再绘制网格，避免动画帧被深度写入切碎。
    app.scene.layers.pushTransparent(this.depthLayer);
    app.scene.layers.pushTransparent(this.guideLayer);
    this.cameraLayerIds = [...camera.layers];
    camera.layers = [...camera.layers, this.depthLayer.id, this.guideLayer.id];

    this.fineGridEntity.addComponent('render', { layers: [this.guideLayer.id] });
    this.coarseGridEntity.addComponent('render', { layers: [this.guideLayer.id] });
    this.cylinderEntity.addComponent('render', { layers: [this.guideLayer.id] });
    this.fineGridEntity.render!.meshInstances = [fineGridInstance];
    this.coarseGridEntity.render!.meshInstances = [coarseGridInstance];
    this.gridEntity.addChild(this.fineGridEntity);
    this.gridEntity.addChild(this.coarseGridEntity);
    this.entity.addChild(this.gridEntity);
    this.entity.addChild(this.axesEntity);
    this.entity.addChild(this.cylinderEntity);
    this.cylinderEntity.enabled = false;
    app.root.addChild(this.entity);

    this.cylinderMaterial.useLighting = false;
    this.cylinderMaterial.emissive = new Color(0.05, 0.88, 1);
    this.cylinderMaterial.blendType = BLEND_NORMAL;
    // #WDD-gpt 2026-08-16 - 圆柱是交互预览而非场景物体，始终覆盖显示，防止圆环完全埋入高斯后不可见。
    this.cylinderMaterial.depthTest = false;
    this.cylinderMaterial.depthWrite = false;
    this.cylinderMaterial.update();

    this.preRenderLayer = app.scene.on('prerender:layer', this.onPreRenderLayer);
    this.postRenderLayer = app.scene.on('postrender:layer', this.onPostRenderLayer);
    this.appUpdate = app.on('update', this.syncDepthProxy);
    this.gsplatMaterialCreated = app.systems.gsplat?.on(
      'material:created',
      this.onGaussianMaterialCreated,
    ) ?? null;
  }

  setEnabled(enabled: boolean): void {
    this.entity.enabled = enabled;
    this.syncEnabledState();
  }

  getEnabled(): boolean {
    return this.entity.enabled;
  }

  setGridVisible(visible: boolean): void {
    this.gridEntity.enabled = visible;
    this.syncEnabledState();
  }

  setAxesVisible(visible: boolean): void {
    this.axesEntity.enabled = visible;
    this.syncEnabledState();
  }

  getGridVisible(): boolean { return this.gridEntity.enabled; }
  getAxesVisible(): boolean { return this.axesEntity.enabled; }

  setSelectionCylinder(region: GaussianCylinderSelectionRegion | null, visible: boolean): void {
    this.cylinderEntity.enabled = visible && region !== null;
    if (!region) {
      this.cylinderEntity.render!.meshInstances = [];
      this.cylinderMesh?.destroy();
      this.cylinderMesh = null;
      this.syncEnabledState();
      return;
    }
    const positions: number[] = [];
    const segments = 48;
    const minimumY = -region.groundPadding;
    const maximumY = region.height;
    const middleY = (minimumY + maximumY) * 0.5;
    const ringPoint = (index: number, y: number): [number, number, number] => {
      const angle = index / segments * Math.PI * 2;
      return [
        region.centerX + Math.cos(angle) * region.radius,
        y,
        region.centerZ + Math.sin(angle) * region.radius,
      ];
    };
    const addLine = (start: readonly number[], end: readonly number[]) => positions.push(...start, ...end);
    for (let index = 0; index < segments; index += 1) {
      addLine(ringPoint(index, minimumY), ringPoint(index + 1, minimumY));
      addLine(ringPoint(index, middleY), ringPoint(index + 1, middleY));
      addLine(ringPoint(index, maximumY), ringPoint(index + 1, maximumY));
      if (index % 4 === 0) addLine(ringPoint(index, minimumY), ringPoint(index, maximumY));
    }
    this.cylinderMesh?.destroy();
    this.cylinderMesh = new Mesh(this.app.graphicsDevice);
    this.cylinderMesh.setPositions(positions);
    this.cylinderMesh.update(PRIMITIVE_LINES);
    const instance = new MeshInstance(this.cylinderMesh, this.cylinderMaterial, this.cylinderEntity);
    instance.castShadow = false;
    instance.receiveShadow = false;
    this.cylinderEntity.render!.meshInstances = [instance];
    this.syncEnabledState();
  }

  setGaussianDepthSourceEnabled(enabled: boolean): void {
    this.gaussianDepthSourceEnabled = enabled;
    if (enabled) {
      this.syncDepthProxy();
    } else {
      this.attachDepthProxy(null);
    }
  }

  destroy(): void {
    this.appUpdate.off();
    this.gsplatMaterialCreated?.off();
    this.preRenderLayer.off();
    this.postRenderLayer.off();
    this.restoreDepthMaterial();
    this.attachDepthProxy(null);
    this.entity.destroy();
    this.camera.layers = this.cameraLayerIds;
    this.app.scene.layers.removeTransparent(this.guideLayer);
    this.app.scene.layers.removeTransparent(this.depthLayer);
    this.fineGridMesh.destroy();
    this.coarseGridMesh.destroy();
    for (const material of this.axisMaterials) material.destroy();
    this.cylinderMesh?.destroy();
    this.material.destroy();
    this.cylinderMaterial.destroy();
  }

  private syncEnabledState(): void {
    this.depthLayer.enabled = this.entity.enabled
      && (this.gridEntity.enabled || this.axesEntity.enabled || this.cylinderEntity.enabled);
  }

  private readonly onGaussianMaterialCreated = (
    material: ShaderMaterial,
    renderCamera: Camera,
    layer: Layer,
  ) => {
    if (
      !this.gaussianDepthSourceEnabled
      || renderCamera !== this.camera.camera
      || layer !== this.app.defaultLayerWorld
    ) return;
    material.depthWrite = false;
    this.syncDepthProxy();
  };

  private readonly syncDepthProxy = () => {
    if (!this.gaussianDepthSourceEnabled) {
      this.attachDepthProxy(null);
      return;
    }
    const gsplatSystem = this.app.systems.gsplat;
    const gaussianMaterial = gsplatSystem?.getMaterial(
      this.camera.camera,
      this.app.defaultLayerWorld,
    ) ?? null;
    if (gaussianMaterial) gaussianMaterial.depthWrite = false;
    const nextProxy = gaussianMaterial
      ? this.app.defaultLayerWorld.meshInstances.find(
        (meshInstance) => meshInstance.material === gaussianMaterial,
      ) ?? null
      : null;
    this.attachDepthProxy(nextProxy);
  };

  private attachDepthProxy(nextProxy: MeshInstance | null): void {
    if (nextProxy === this.depthProxy) return;
    this.restoreDepthMaterial();
    if (this.depthProxy) this.depthLayer.removeMeshInstances([this.depthProxy], true);
    this.depthProxy = nextProxy;
    if (nextProxy) this.depthLayer.addMeshInstances([nextProxy], true);
  }

  private readonly onPreRenderLayer = (
    renderCamera: CameraComponent,
    layer: Layer,
    transparent: boolean,
  ) => {
    if (renderCamera !== this.camera || layer !== this.depthLayer || !transparent) return;
    const material = this.depthProxy?.material;
    if (!material || this.depthMaterialState) return;
    this.depthMaterialState = {
      alphaClipForward: readNumberParameter(
        material,
        'alphaClipForward',
        this.app.scene.gsplat.alphaClipForward,
      ),
      alphaWrite: material.alphaWrite,
      blueWrite: material.blueWrite,
      depthWrite: material.depthWrite,
      greenWrite: material.greenWrite,
      material,
      redWrite: material.redWrite,
    };
    material.depthWrite = true;
    material.redWrite = false;
    material.greenWrite = false;
    material.blueWrite = false;
    material.alphaWrite = false;
    material.setParameter('alphaClipForward', GAUSSIAN_OCCLUSION_ALPHA_CLIP);
  };

  private readonly onPostRenderLayer = (
    renderCamera: CameraComponent,
    layer: Layer,
    transparent: boolean,
  ) => {
    if (renderCamera === this.camera && layer === this.depthLayer && transparent) {
      this.restoreDepthMaterial();
    }
  };

  private restoreDepthMaterial(): void {
    const state = this.depthMaterialState;
    if (!state) return;
    state.material.depthWrite = state.depthWrite;
    state.material.redWrite = state.redWrite;
    state.material.greenWrite = state.greenWrite;
    state.material.blueWrite = state.blueWrite;
    state.material.alphaWrite = state.alphaWrite;
    state.material.setParameter('alphaClipForward', state.alphaClipForward);
    this.depthMaterialState = null;
  }
}
