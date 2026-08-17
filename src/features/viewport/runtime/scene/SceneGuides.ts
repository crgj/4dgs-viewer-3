import {
  Application,
  BLEND_NORMAL,
  Color,
  CULLFACE_NONE,
  type Camera,
  type CameraComponent,
  Entity,
  type EventHandle,
  Layer,
  type Material,
  Mesh,
  MeshInstance,
  PRIMITIVE_LINES,
  PRIMITIVE_TRIANGLES,
  type ShaderMaterial,
  SORTMODE_NONE,
  StandardMaterial,
  Vec3,
} from 'playcanvas';
import type { GaussianCylinderSelectionRegion } from '../selection/GaussianCylinderSelection';
import type { GaussianEnvelopeMeshData } from './GaussianEnvelope';

const AXIS_LENGTH_METERS = 1;
const UP_AXIS_LENGTH_METERS = 1;
const AXIS_SURFACE_OFFSET = 0.006;
const AXIS_THICKNESS_METERS = 0.015;
const HEIGHT_RULER_HEIGHT_METERS = 2;
const HEIGHT_RULER_INITIAL_X_METERS = -0.8;
const HEIGHT_RULER_INITIAL_Z_METERS = 0;
const HEIGHT_RULER_TICK_CENTIMETERS = 1;
const GAUSSIAN_OCCLUSION_ALPHA_CLIP = 0.16;

// #WDD-gpt 2026-08-16 - 固定采用 DCC 常用的 X 红、Y 绿、Z 蓝，避免轴线在暗色视口中混成灰白色。
export const SCENE_AXIS_COLORS = {
  x: [255, 64, 72, 255],
  y: [66, 224, 112, 255],
  z: [64, 128, 255, 255],
} as const;

export const SCENE_AXIS_SEGMENTS = {
  x: { start: [0, AXIS_SURFACE_OFFSET, 0], end: [AXIS_LENGTH_METERS, AXIS_SURFACE_OFFSET, 0] },
  // #WDD-gpt 2026-08-16 - 三色坐标轴统一保持 1m，人物高度测量改由独立身高尺承担。
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

export const SCENE_HEIGHT_RULER = {
  height: HEIGHT_RULER_HEIGHT_METERS,
  origin: [HEIGHT_RULER_INITIAL_X_METERS, 0, HEIGHT_RULER_INITIAL_Z_METERS],
  barPosition: [0, HEIGHT_RULER_HEIGHT_METERS * 0.5, 0],
  barScale: [0.009, HEIGHT_RULER_HEIGHT_METERS, 0.009],
} as const;

// #WDD-gpt 2026-08-16 - 独立身高尺精确到 1cm，5cm/10cm 分级加长，每 10cm 产生数字标签。
export const SCENE_HEIGHT_RULER_TICKS = Array.from(
  { length: Math.round(HEIGHT_RULER_HEIGHT_METERS * 100 / HEIGHT_RULER_TICK_CENTIMETERS) + 1 },
  (_, index) => {
    const centimeters = index * HEIGHT_RULER_TICK_CENTIMETERS;
    const isDecimeter = centimeters % 10 === 0;
    const isHalfDecimeter = centimeters % 5 === 0;
    const isWholeMeter = centimeters % 100 === 0;
    return {
      alpha: isWholeMeter ? 255 : isDecimeter ? 220 : isHalfDecimeter ? 108 : 34,
      centimeters,
      height: centimeters / 100,
      label: isDecimeter ? centimeters : null,
      length: isWholeMeter ? 0.16 : isDecimeter ? 0.12 : isHalfDecimeter ? 0.065 : 0.028,
    };
  },
) as readonly {
  readonly alpha: number;
  readonly centimeters: number;
  readonly height: number;
  readonly label: number | null;
  readonly length: number;
}[];

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
  private readonly heightRulerEntity = new Entity('Character Height Ruler 2m');
  private readonly cylinderEntity = new Entity('Selection Cylinder');
  private readonly gaussianEnvelopeEntity = new Entity('Undeleted Gaussian Envelope');
  private readonly fineGridMesh: Mesh;
  private readonly coarseGridMesh: Mesh;
  private readonly heightRulerTickMesh: Mesh;
  private readonly material = new StandardMaterial();
  private readonly axisMaterials: StandardMaterial[] = [];
  private readonly cylinderMaterial = new StandardMaterial();
  private readonly gaussianEnvelopeFillMaterial = new StandardMaterial();
  private readonly gaussianEnvelopeWireMaterial = new StandardMaterial();
  private readonly heightRulerLabelContainer: HTMLDivElement | null;
  private readonly heightRulerProjectedElements: readonly {
    readonly element: HTMLElement;
    readonly height: number;
    readonly xOffset: number;
  }[];
  private readonly heightRulerHandle: HTMLButtonElement | null;
  private readonly heightRulerLabelWorld = new Vec3();
  private readonly heightRulerLabelScreen = new Vec3();
  private readonly heightRulerPosition = new Vec3(...SCENE_HEIGHT_RULER.origin);
  private heightRulerDrag: {
    readonly metersPerPixel: number;
    readonly originX: number;
    readonly originZ: number;
    readonly pointerId: number;
    readonly rightX: number;
    readonly rightZ: number;
    readonly startX: number;
    readonly startY: number;
    readonly upX: number;
    readonly upZ: number;
  } | null = null;
  private cylinderMesh: Mesh | null = null;
  private gaussianEnvelopeFillMesh: Mesh | null = null;
  private gaussianEnvelopeWireMesh: Mesh | null = null;
  private gaussianEnvelopeVisible = false;
  private hasGaussianEnvelope = false;
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
  private readonly heightRulerUpdate: EventHandle;
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

    const heightRulerTickPositions: number[] = [];
    const heightRulerTickColors: number[] = [];
    for (const tick of SCENE_HEIGHT_RULER_TICKS) {
      heightRulerTickPositions.push(
        0, tick.height, 0,
        tick.length, tick.height, 0,
      );
      for (let vertex = 0; vertex < 2; vertex += 1) {
        heightRulerTickColors.push(255, 184, 70, tick.alpha);
      }
    }
    this.heightRulerTickMesh = new Mesh(app.graphicsDevice);
    this.heightRulerTickMesh.setPositions(heightRulerTickPositions);
    this.heightRulerTickMesh.setColors32(heightRulerTickColors);
    this.heightRulerTickMesh.update(PRIMITIVE_LINES);

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
      parent = this.axesEntity,
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
      parent.addChild(axis);
    };
    // #WDD-gpt 2026-08-16 - 坐标轴仅表示世界方向，三轴长度统一为 1m。
    createAxisBar('Axis X · 1m', SCENE_AXIS_BARS.x.position, SCENE_AXIS_BARS.x.scale, SCENE_AXIS_COLORS.x);
    createAxisBar('Axis Y · 1m', SCENE_AXIS_BARS.y.position, SCENE_AXIS_BARS.y.scale, SCENE_AXIS_COLORS.y);
    createAxisBar('Axis Z · 1m', SCENE_AXIS_BARS.z.position, SCENE_AXIS_BARS.z.scale, SCENE_AXIS_COLORS.z);
    createAxisBar(
      'Character Height Ruler · 2m',
      SCENE_HEIGHT_RULER.barPosition,
      SCENE_HEIGHT_RULER.barScale,
      [255, 184, 70, 255],
      this.heightRulerEntity,
    );
    const heightRulerTickInstance = new MeshInstance(
      this.heightRulerTickMesh,
      this.material,
      this.heightRulerEntity,
    );
    heightRulerTickInstance.castShadow = false;
    heightRulerTickInstance.receiveShadow = false;
    this.heightRulerEntity.addComponent('render', { layers: [this.guideLayer.id] });
    this.heightRulerEntity.render!.meshInstances = [heightRulerTickInstance];
    this.heightRulerEntity.setLocalPosition(this.heightRulerPosition);

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
    this.entity.addChild(this.heightRulerEntity);
    this.entity.addChild(this.cylinderEntity);
    this.gaussianEnvelopeEntity.addComponent('render', { layers: [this.guideLayer.id] });
    this.entity.addChild(this.gaussianEnvelopeEntity);
    this.cylinderEntity.enabled = false;
    this.gaussianEnvelopeEntity.enabled = false;
    app.root.addChild(this.entity);
    const rulerLabels = this.createHeightRulerLabels();
    this.heightRulerLabelContainer = rulerLabels.container;
    this.heightRulerProjectedElements = rulerLabels.elements;
    this.heightRulerHandle = rulerLabels.handle;

    this.cylinderMaterial.useLighting = false;
    this.cylinderMaterial.emissive = new Color(0.05, 0.88, 1);
    this.cylinderMaterial.blendType = BLEND_NORMAL;
    // #WDD-gpt 2026-08-16 - 圆柱是交互预览而非场景物体，始终覆盖显示，防止圆环完全埋入高斯后不可见。
    this.cylinderMaterial.depthTest = false;
    this.cylinderMaterial.depthWrite = false;
    this.cylinderMaterial.update();

    this.gaussianEnvelopeFillMaterial.useLighting = false;
    this.gaussianEnvelopeFillMaterial.diffuse.set(0, 0, 0);
    this.gaussianEnvelopeFillMaterial.emissive = new Color(1, 0.38, 0.04);
    this.gaussianEnvelopeFillMaterial.opacity = 0.09;
    this.gaussianEnvelopeFillMaterial.blendType = BLEND_NORMAL;
    this.gaussianEnvelopeFillMaterial.cull = CULLFACE_NONE;
    this.gaussianEnvelopeFillMaterial.depthTest = true;
    this.gaussianEnvelopeFillMaterial.depthWrite = false;
    this.gaussianEnvelopeFillMaterial.update();

    this.gaussianEnvelopeWireMaterial.useLighting = false;
    this.gaussianEnvelopeWireMaterial.diffuse.set(0, 0, 0);
    this.gaussianEnvelopeWireMaterial.emissive = new Color(1, 0.62, 0.12);
    this.gaussianEnvelopeWireMaterial.blendType = BLEND_NORMAL;
    // #WDD-gpt 2026-08-16 - 外包络边线覆盖显示，远端杂点形成的尖角不会被主体高斯遮住。
    this.gaussianEnvelopeWireMaterial.depthTest = false;
    this.gaussianEnvelopeWireMaterial.depthWrite = false;
    this.gaussianEnvelopeWireMaterial.update();

    this.preRenderLayer = app.scene.on('prerender:layer', this.onPreRenderLayer);
    this.postRenderLayer = app.scene.on('postrender:layer', this.onPostRenderLayer);
    this.appUpdate = app.on('update', this.syncDepthProxy);
    this.heightRulerUpdate = app.on('update', this.updateHeightRuler);
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

  setHeightRulerVisible(visible: boolean): void {
    this.heightRulerEntity.enabled = visible;
    this.syncEnabledState();
    this.updateHeightRuler();
  }

  getGridVisible(): boolean { return this.gridEntity.enabled; }
  getAxesVisible(): boolean { return this.axesEntity.enabled; }
  getHeightRulerVisible(): boolean { return this.heightRulerEntity.enabled; }

  setGaussianEnvelopeVisible(visible: boolean): void {
    this.gaussianEnvelopeVisible = visible;
    this.syncEnabledState();
  }

  getGaussianEnvelopeVisible(): boolean { return this.gaussianEnvelopeVisible; }

  setGaussianEnvelope(
    envelope: GaussianEnvelopeMeshData | null,
    transform: {
      readonly position: readonly [number, number, number];
      readonly rotation: readonly [number, number, number];
      readonly scale: readonly [number, number, number];
    },
  ): void {
    this.gaussianEnvelopeFillMesh?.destroy();
    this.gaussianEnvelopeWireMesh?.destroy();
    this.gaussianEnvelopeFillMesh = null;
    this.gaussianEnvelopeWireMesh = null;
    this.gaussianEnvelopeEntity.render!.meshInstances = [];
    this.hasGaussianEnvelope = envelope !== null;
    if (envelope) {
      this.gaussianEnvelopeFillMesh = new Mesh(this.app.graphicsDevice);
      this.gaussianEnvelopeFillMesh.setPositions(envelope.positions);
      this.gaussianEnvelopeFillMesh.setIndices(envelope.triangleIndices);
      this.gaussianEnvelopeFillMesh.update(PRIMITIVE_TRIANGLES);
      this.gaussianEnvelopeWireMesh = new Mesh(this.app.graphicsDevice);
      this.gaussianEnvelopeWireMesh.setPositions(envelope.positions);
      this.gaussianEnvelopeWireMesh.setIndices(envelope.edgeIndices);
      this.gaussianEnvelopeWireMesh.update(PRIMITIVE_LINES);
      const fillInstance = new MeshInstance(
        this.gaussianEnvelopeFillMesh, this.gaussianEnvelopeFillMaterial, this.gaussianEnvelopeEntity,
      );
      const wireInstance = new MeshInstance(
        this.gaussianEnvelopeWireMesh, this.gaussianEnvelopeWireMaterial, this.gaussianEnvelopeEntity,
      );
      fillInstance.castShadow = false; fillInstance.receiveShadow = false;
      wireInstance.castShadow = false; wireInstance.receiveShadow = false;
      this.gaussianEnvelopeEntity.render!.meshInstances = [fillInstance, wireInstance];
    }
    this.setGaussianEnvelopeTransform(transform);
    this.syncEnabledState();
  }

  setGaussianEnvelopeTransform(transform: {
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number];
    readonly scale: readonly [number, number, number];
  }): void {
    this.gaussianEnvelopeEntity.setLocalPosition(...transform.position);
    this.gaussianEnvelopeEntity.setLocalEulerAngles(...transform.rotation);
    this.gaussianEnvelopeEntity.setLocalScale(...transform.scale);
  }

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
    this.heightRulerUpdate.off();
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
    this.heightRulerTickMesh.destroy();
    for (const material of this.axisMaterials) material.destroy();
    this.cylinderMesh?.destroy();
    this.gaussianEnvelopeFillMesh?.destroy();
    this.gaussianEnvelopeWireMesh?.destroy();
    this.material.destroy();
    this.cylinderMaterial.destroy();
    this.gaussianEnvelopeFillMaterial.destroy();
    this.gaussianEnvelopeWireMaterial.destroy();
    window.removeEventListener('pointermove', this.onHeightRulerPointerMove, true);
    window.removeEventListener('pointerup', this.onHeightRulerPointerUp, true);
    window.removeEventListener('pointercancel', this.onHeightRulerPointerUp, true);
    window.removeEventListener('mousemove', this.onHeightRulerMouseMove, true);
    window.removeEventListener('mouseup', this.onHeightRulerMouseUp, true);
    this.heightRulerHandle?.removeEventListener('pointerdown', this.onHeightRulerPointerDown);
    this.heightRulerLabelContainer?.remove();
  }

  private syncEnabledState(): void {
    this.gaussianEnvelopeEntity.enabled = this.gaussianEnvelopeVisible && this.hasGaussianEnvelope;
    this.depthLayer.enabled = this.entity.enabled
      && (this.gridEntity.enabled || this.axesEntity.enabled || this.heightRulerEntity.enabled || this.cylinderEntity.enabled);
    this.updateHeightRuler();
  }

  private createHeightRulerLabels(): {
    readonly container: HTMLDivElement | null;
    readonly elements: readonly { readonly element: HTMLElement; readonly height: number; readonly xOffset: number }[];
    readonly handle: HTMLButtonElement | null;
  } {
    const parent = this.app.graphicsDevice.canvas.parentElement;
    if (!parent) return { container: null, elements: [], handle: null };
    const container = document.createElement('div');
    container.className = 'height-ruler-labels';
    const elements: { element: HTMLElement; height: number; xOffset: number }[] = SCENE_HEIGHT_RULER_TICKS
      .filter((tick) => tick.label !== null)
      .map((tick) => {
        const element = document.createElement('span');
        element.className = tick.centimeters % 100 === 0
          ? 'height-ruler-label meter'
          : 'height-ruler-label';
        element.setAttribute('aria-hidden', 'true');
        element.textContent = tick.centimeters === 200 ? '200 cm' : String(tick.centimeters);
        container.append(element);
        return { element, height: tick.height, xOffset: 9 };
      });
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'height-ruler-handle';
    handle.setAttribute('aria-label', '拖动身高尺');
    handle.setAttribute('data-camera-input-block', '');
    handle.draggable = false;
    handle.textContent = '⋮⋮  身高尺';
    handle.addEventListener('pointerdown', this.onHeightRulerPointerDown);
    container.append(handle);
    elements.push({ element: handle, height: HEIGHT_RULER_HEIGHT_METERS * 0.5, xOffset: 32 });
    parent.append(container);
    return { container, elements, handle };
  }

  private readonly updateHeightRuler = (): void => {
    const container = this.heightRulerLabelContainer;
    if (!container) return;
    const visible = this.entity.enabled && this.heightRulerEntity.enabled;
    container.hidden = !visible;
    if (!visible) return;
    const canvas = this.app.graphicsDevice.canvas;
    const parent = canvas.parentElement;
    const cameraEntity = this.camera.entity;
    if (!parent || !cameraEntity) return;
    const canvasBounds = canvas.getBoundingClientRect();
    const parentBounds = parent.getBoundingClientRect();
    const cameraPosition = cameraEntity.getPosition();
    const cameraForward = cameraEntity.forward;
    const yaw = Math.atan2(
      cameraPosition.x - this.heightRulerPosition.x,
      cameraPosition.z - this.heightRulerPosition.z,
    ) * 180 / Math.PI;
    this.heightRulerEntity.setLocalEulerAngles(0, yaw, 0);
    for (const projected of this.heightRulerProjectedElements) {
      this.heightRulerLabelWorld.set(this.heightRulerPosition.x, projected.height, this.heightRulerPosition.z);
      const offsetX = this.heightRulerLabelWorld.x - cameraPosition.x;
      const offsetY = this.heightRulerLabelWorld.y - cameraPosition.y;
      const offsetZ = this.heightRulerLabelWorld.z - cameraPosition.z;
      const depth = offsetX * cameraForward.x + offsetY * cameraForward.y + offsetZ * cameraForward.z;
      this.camera.worldToScreen(this.heightRulerLabelWorld, this.heightRulerLabelScreen);
      const x = this.heightRulerLabelScreen.x + canvasBounds.left - parentBounds.left + projected.xOffset;
      const y = this.heightRulerLabelScreen.y + canvasBounds.top - parentBounds.top;
      const inViewport = depth > 0
        && x >= canvasBounds.left - parentBounds.left
        && x <= canvasBounds.right - parentBounds.left
        && y >= canvasBounds.top - parentBounds.top
        && y <= canvasBounds.bottom - parentBounds.top;
      projected.element.hidden = !inViewport;
      if (inViewport) projected.element.style.transform = `translate(${x}px, ${y}px) translateY(-50%)`;
    }
  };

  // #WDD-gpt 2026-08-16 - 拖动柄将屏幕位移投影到地面 XZ 基底，移动身高尺时不触发摄像机旋转。
  private readonly onHeightRulerPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.heightRulerHandle) return;
    event.preventDefault();
    event.stopPropagation();
    const cameraEntity = this.camera.entity;
    const canvas = this.app.graphicsDevice.canvas;
    const cameraPosition = cameraEntity.getPosition();
    const rulerCenter = this.heightRulerPosition.clone();
    rulerCenter.y = HEIGHT_RULER_HEIGHT_METERS * 0.5;
    const distance = Math.max(0.1, cameraPosition.distance(rulerCenter));
    const verticalFovRadians = this.camera.horizontalFov
      ? 2 * Math.atan(Math.tan(this.camera.fov * Math.PI / 360) * canvas.clientHeight / Math.max(1, canvas.clientWidth))
      : this.camera.fov * Math.PI / 180;
    const metersPerPixel = 2 * distance * Math.tan(verticalFovRadians * 0.5) / Math.max(1, canvas.clientHeight);
    const cameraRight = cameraEntity.right;
    const cameraUp = cameraEntity.up;
    const cameraForward = cameraEntity.forward;
    const rightLength = Math.hypot(cameraRight.x, cameraRight.z) || 1;
    let upX = cameraUp.x;
    let upZ = cameraUp.z;
    let upLength = Math.hypot(upX, upZ);
    if (upLength < 1e-4) {
      upX = -cameraForward.x;
      upZ = -cameraForward.z;
      upLength = Math.hypot(upX, upZ) || 1;
    }
    this.heightRulerDrag = {
      metersPerPixel,
      originX: this.heightRulerPosition.x,
      originZ: this.heightRulerPosition.z,
      pointerId: event.pointerId,
      rightX: cameraRight.x / rightLength,
      rightZ: cameraRight.z / rightLength,
      startX: event.clientX,
      startY: event.clientY,
      upX: upX / upLength,
      upZ: upZ / upLength,
    };
    this.heightRulerHandle.setPointerCapture(event.pointerId);
    this.heightRulerHandle.classList.add('dragging');
    window.addEventListener('pointermove', this.onHeightRulerPointerMove, true);
    window.addEventListener('pointerup', this.onHeightRulerPointerUp, true);
    window.addEventListener('pointercancel', this.onHeightRulerPointerUp, true);
    window.addEventListener('mousemove', this.onHeightRulerMouseMove, true);
    window.addEventListener('mouseup', this.onHeightRulerMouseUp, true);
  };

  private readonly onHeightRulerPointerMove = (event: PointerEvent): void => {
    const drag = this.heightRulerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.moveHeightRulerTo(event.clientX, event.clientY);
  };

  private readonly onHeightRulerMouseMove = (event: MouseEvent): void => {
    if (!this.heightRulerDrag) return;
    event.preventDefault();
    event.stopPropagation();
    this.moveHeightRulerTo(event.clientX, event.clientY);
  };

  private moveHeightRulerTo(clientX: number, clientY: number): void {
    const drag = this.heightRulerDrag;
    if (!drag) return;
    const deltaX = (clientX - drag.startX) * drag.metersPerPixel;
    const deltaY = (drag.startY - clientY) * drag.metersPerPixel;
    this.heightRulerPosition.set(
      drag.originX + drag.rightX * deltaX + drag.upX * deltaY,
      0,
      drag.originZ + drag.rightZ * deltaX + drag.upZ * deltaY,
    );
    this.heightRulerEntity.setLocalPosition(this.heightRulerPosition);
    this.updateHeightRuler();
  }

  private readonly onHeightRulerPointerUp = (event: PointerEvent): void => {
    if (this.heightRulerDrag?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.finishHeightRulerDrag();
  };

  private readonly onHeightRulerMouseUp = (event: MouseEvent): void => {
    if (!this.heightRulerDrag) return;
    event.preventDefault();
    event.stopPropagation();
    this.finishHeightRulerDrag();
  };

  private finishHeightRulerDrag(): void {
    const pointerId = this.heightRulerDrag?.pointerId;
    this.heightRulerDrag = null;
    window.removeEventListener('pointermove', this.onHeightRulerPointerMove, true);
    window.removeEventListener('pointerup', this.onHeightRulerPointerUp, true);
    window.removeEventListener('pointercancel', this.onHeightRulerPointerUp, true);
    window.removeEventListener('mousemove', this.onHeightRulerMouseMove, true);
    window.removeEventListener('mouseup', this.onHeightRulerMouseUp, true);
    if (pointerId !== undefined && this.heightRulerHandle?.hasPointerCapture(pointerId)) {
      this.heightRulerHandle.releasePointerCapture(pointerId);
    }
    this.heightRulerHandle?.classList.remove('dragging');
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
