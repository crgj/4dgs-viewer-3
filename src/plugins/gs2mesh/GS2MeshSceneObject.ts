import {
  Application,
  CULLFACE_NONE,
  Color,
  Entity,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  StandardMaterial,
  calculateNormals,
} from 'playcanvas';
import type { GS2MeshData, GS2MeshSceneStats } from './GS2MeshTypes';

export class GS2MeshSceneObject {
  private readonly entity = new Entity('GS2Mesh · Current Frame');
  private readonly mesh: Mesh;
  private readonly material = new StandardMaterial();
  private relightingEntity: Entity | null = null;
  private relightingMaterial: StandardMaterial | null = null;
  private readonly boundsCenter: readonly [number, number, number];
  private readonly boundsRadius: number;
  readonly stats: GS2MeshSceneStats;

  constructor(app: Application, data: GS2MeshData) {
    const normals = data.normals ?? Float32Array.from(calculateNormals(Array.from(data.positions), Array.from(data.indices)));
    this.mesh = new Mesh(app.graphicsDevice);
    // #WDD-gpt 2026-08-15 - Preserve typed mesh buffers so a sparse 1024³ result is not duplicated into large boxed-number arrays during scene installation.
    this.mesh.setPositions(data.positions);
    this.mesh.setNormals(normals);
    this.mesh.setColors32(data.colors);
    this.mesh.setIndices(data.indices);
    this.mesh.update(PRIMITIVE_TRIANGLES);

    this.material.diffuse = Color.WHITE;
    this.material.emissive = Color.WHITE;
    this.material.diffuseVertexColor = true;
    this.material.emissiveVertexColor = true;
    this.material.useLighting = false;
    this.material.cull = CULLFACE_NONE;
    this.material.depthTest = true;
    this.material.depthWrite = true;
    this.material.update();

    const meshInstance = new MeshInstance(this.mesh, this.material, this.entity);
    meshInstance.castShadow = false;
    meshInstance.receiveShadow = false;
    this.entity.addComponent('render');
    this.entity.render!.meshInstances = [meshInstance];
    app.root.addChild(this.entity);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < data.positions.length; index += 3) {
      minX = Math.min(minX, data.positions[index]);
      minY = Math.min(minY, data.positions[index + 1]);
      minZ = Math.min(minZ, data.positions[index + 2]);
      maxX = Math.max(maxX, data.positions[index]);
      maxY = Math.max(maxY, data.positions[index + 1]);
      maxZ = Math.max(maxZ, data.positions[index + 2]);
    }
    this.boundsCenter = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    this.boundsRadius = Math.max(
      0.01,
      Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
    );
    this.stats = {
      vertexCount: data.positions.length / 3,
      triangleCount: data.indices.length / 3,
    };
  }

  setVisible(visible: boolean): void {
    this.entity.enabled = visible;
  }

  get visible(): boolean {
    return this.entity.enabled;
  }

  getRelightingPlacement(): { readonly center: readonly [number, number, number]; readonly radius: number } {
    return { center: this.boundsCenter, radius: this.boundsRadius };
  }

  // #WDD-gpt 2026-08-15 - 复用同一 GS2Mesh GPU 网格建立只对离屏相机可见的中性代理，避免复制大规模顶点缓冲。
  installRelightingProxy(
    app: Application,
    layerId: number,
    configureMaterial: (material: StandardMaterial) => void,
  ): void {
    this.removeRelightingProxy();
    const material = new StandardMaterial();
    material.diffuse = new Color(0.5, 0.5, 0.5);
    material.emissive = Color.BLACK;
    material.useLighting = true;
    // #WDD-gpt 2026-08-16 - GS2Mesh is intentionally rendered without culling; flip the fragment normal on visible backfaces so noisy/inconsistent reconstructed winding does not invert point-light shading.
    material.twoSidedLighting = true;
    material.useSkybox = false;
    material.cull = CULLFACE_NONE;
    material.depthTest = true;
    material.depthWrite = true;
    configureMaterial(material);

    const entity = new Entity('GS2Mesh · Relighting Proxy');
    const meshInstance = new MeshInstance(this.mesh, material, entity);
    meshInstance.castShadow = true;
    meshInstance.receiveShadow = true;
    entity.addComponent('render');
    entity.render!.layers = [layerId];
    entity.render!.meshInstances = [meshInstance];
    app.root.addChild(entity);
    this.relightingEntity = entity;
    this.relightingMaterial = material;
  }

  setRelightingProxyEnabled(enabled: boolean): void {
    if (this.relightingEntity) this.relightingEntity.enabled = enabled;
  }

  removeRelightingProxy(): void {
    this.relightingEntity?.destroy();
    this.relightingEntity = null;
    this.relightingMaterial?.destroy();
    this.relightingMaterial = null;
  }

  destroy(): void {
    this.removeRelightingProxy();
    this.entity.destroy();
    this.mesh.destroy();
    this.material.destroy();
  }
}
