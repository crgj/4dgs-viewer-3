import {
  Application,
  BLEND_NORMAL,
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

const AXIS_LENGTH_METERS = 1;
const AXIS_SURFACE_OFFSET = 0.006;
const GAUSSIAN_OCCLUSION_ALPHA_CLIP = 0.16;

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
  private readonly mesh: Mesh;
  private readonly material = new StandardMaterial();
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
    const positions: number[] = [];
    const colors: number[] = [];
    const half = size / 2;
    const step = size / divisions;
    const pushLine = (
      start: [number, number, number],
      end: [number, number, number],
      color: [number, number, number, number],
    ) => {
      positions.push(...start, ...end);
      colors.push(...color, ...color);
    };

    for (let i = 0; i <= divisions; i += 1) {
      const offset = -half + i * step;
      const isMajor = i === 0 || i === divisions || i === divisions / 2 || i % 5 === 0;
      const color: [number, number, number, number] = isMajor
        ? [58, 71, 94, 150]
        : [34, 42, 57, 95];

      pushLine([-half, 0, offset], [half, 0, offset], color);
      pushLine([offset, 0, -half], [offset, 0, half], color);
    }

    // #WDD-gpt 2026-08-15 - 世界坐标采用米制，X/Y/Z 三色轴从原点起均精确显示 1 m。
    pushLine([0, AXIS_SURFACE_OFFSET, 0], [AXIS_LENGTH_METERS, AXIS_SURFACE_OFFSET, 0], [245, 64, 78, 255]);
    pushLine([0, AXIS_SURFACE_OFFSET, 0], [0, AXIS_LENGTH_METERS, 0], [74, 226, 126, 255]);
    pushLine([0, AXIS_SURFACE_OFFSET, 0], [0, AXIS_SURFACE_OFFSET, AXIS_LENGTH_METERS], [57, 125, 255, 255]);

    this.mesh = new Mesh(app.graphicsDevice);
    this.mesh.setPositions(positions);
    this.mesh.setColors32(colors);
    this.mesh.update(PRIMITIVE_LINES);

    this.material.useLighting = false;
    this.material.emissiveVertexColor = true;
    this.material.opacityVertexColor = true;
    this.material.blendType = BLEND_NORMAL;
    this.material.depthTest = true;
    this.material.depthWrite = false;
    this.material.update();

    const meshInstance = new MeshInstance(this.mesh, this.material, this.entity);
    meshInstance.castShadow = false;
    meshInstance.receiveShadow = false;

    // #WDD-gpt  2026-08-15 - 彩色高斯保持标准透明混合；单独追加仅深度通道后再绘制网格，避免动画帧被深度写入切碎。
    app.scene.layers.pushTransparent(this.depthLayer);
    app.scene.layers.pushTransparent(this.guideLayer);
    this.cameraLayerIds = [...camera.layers];
    camera.layers = [...camera.layers, this.depthLayer.id, this.guideLayer.id];

    this.entity.addComponent('render', { layers: [this.guideLayer.id] });
    this.entity.render!.meshInstances = [meshInstance];
    app.root.addChild(this.entity);

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
    this.depthLayer.enabled = enabled;
  }

  getEnabled(): boolean {
    return this.entity.enabled;
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
    this.mesh.destroy();
    this.material.destroy();
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
