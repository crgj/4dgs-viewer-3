import {
  Application,
  CULLFACE_NONE,
  Color,
  Entity,
  type Mat4,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  StandardMaterial,
  Vec3,
  calculateNormals,
} from 'playcanvas';
import type { GS2MeshData, GS2MeshSceneStats } from './GS2MeshTypes';

function signedMeshVolume(positions: Float32Array, indices?: Uint32Array): number {
  if (!indices || indices.length < 3) return 0;
  let volume6 = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] * 3;
    const b = indices[offset + 1] * 3;
    const c = indices[offset + 2] * 3;
    volume6 += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      + positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return volume6 / 6;
}

// #WDD-gpt 2026-08-16 - Prefer signed closed-volume winding over a body-center guess so concave GS2Mesh surfaces cannot flip the light to the opposite side.
export function orientNormalsOutward(
  positions: Float32Array,
  normals: Float32Array,
  indices?: Uint32Array,
): Float32Array {
  if (positions.length !== normals.length || positions.length < 3) return normals;
  const volume = signedMeshVolume(positions, indices);
  if (Math.abs(volume) > 1e-12) {
    if (volume > 0) return normals;
    return Float32Array.from(normals, (value) => -value);
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < positions.length; offset += 3) {
    minX = Math.min(minX, positions[offset]);
    minY = Math.min(minY, positions[offset + 1]);
    minZ = Math.min(minZ, positions[offset + 2]);
    maxX = Math.max(maxX, positions[offset]);
    maxY = Math.max(maxY, positions[offset + 1]);
    maxZ = Math.max(maxZ, positions[offset + 2]);
  }
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  let orientationScore = 0;
  let samples = 0;
  for (let offset = 0; offset < positions.length; offset += 3) {
    const radialX = positions[offset] - centerX;
    const radialY = positions[offset + 1] - centerY;
    const radialZ = positions[offset + 2] - centerZ;
    const normalX = normals[offset];
    const normalY = normals[offset + 1];
    const normalZ = normals[offset + 2];
    const denominator = Math.hypot(radialX, radialY, radialZ) * Math.hypot(normalX, normalY, normalZ);
    if (denominator <= 1e-8) continue;
    orientationScore += (radialX * normalX + radialY * normalY + radialZ * normalZ) / denominator;
    samples += 1;
  }
  if (samples === 0 || orientationScore >= -samples * 0.01) return normals;
  const oriented = new Float32Array(normals.length);
  for (let index = 0; index < normals.length; index += 1) oriented[index] = -normals[index];
  return oriented;
}

function transformPositionsToLocal(positions: Float32Array, worldToLocal: Mat4): Float32Array {
  const output = new Float32Array(positions.length);
  const source = new Vec3();
  const target = new Vec3();
  for (let offset = 0; offset < positions.length; offset += 3) {
    worldToLocal.transformPoint(source.set(positions[offset], positions[offset + 1], positions[offset + 2]), target);
    output.set([target.x, target.y, target.z], offset);
  }
  return output;
}

function transformNormalsToLocal(normals: Float32Array, localToWorld: Mat4): Float32Array {
  const matrix = localToWorld.data;
  const output = new Float32Array(normals.length);
  for (let offset = 0; offset < normals.length; offset += 3) {
    const x = matrix[0] * normals[offset] + matrix[1] * normals[offset + 1] + matrix[2] * normals[offset + 2];
    const y = matrix[4] * normals[offset] + matrix[5] * normals[offset + 1] + matrix[6] * normals[offset + 2];
    const z = matrix[8] * normals[offset] + matrix[9] * normals[offset + 1] + matrix[10] * normals[offset + 2];
    const inverseLength = 1 / Math.max(1e-12, Math.hypot(x, y, z));
    output.set([x * inverseLength, y * inverseLength, z * inverseLength], offset);
  }
  return output;
}

export class GS2MeshSceneObject {
  private readonly entity = new Entity('GS2Mesh · Current Frame');
  private readonly mesh: Mesh;
  private readonly material = new StandardMaterial();
  private relightingEntity: Entity | null = null;
  private relightingMaterial: StandardMaterial | null = null;
  private readonly boundsCenter: readonly [number, number, number];
  private readonly boundsRadius: number;
  readonly stats: GS2MeshSceneStats;

  constructor(app: Application, data: GS2MeshData, transformSource?: Entity | null) {
    const sourceWorld = transformSource?.getWorldTransform().clone() ?? null;
    const positions = sourceWorld
      ? transformPositionsToLocal(data.positions, sourceWorld.clone().invert())
      : data.positions;
    const sourceNormals = data.normals
      ? sourceWorld ? transformNormalsToLocal(data.normals, sourceWorld) : data.normals
      : Float32Array.from(calculateNormals(Array.from(positions), Array.from(data.indices)));
    const normals = orientNormalsOutward(positions, sourceNormals, data.indices);
    this.mesh = new Mesh(app.graphicsDevice);
    // #WDD-gpt 2026-08-15 - Preserve typed mesh buffers so a sparse 1024³ result is not duplicated into large boxed-number arrays during scene installation.
    this.mesh.setPositions(positions);
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
    if (transformSource) this.syncTransform(transformSource);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < positions.length; index += 3) {
      minX = Math.min(minX, positions[index]);
      minY = Math.min(minY, positions[index + 1]);
      minZ = Math.min(minZ, positions[index + 2]);
      maxX = Math.max(maxX, positions[index]);
      maxY = Math.max(maxY, positions[index + 1]);
      maxZ = Math.max(maxZ, positions[index + 2]);
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
    const center = this.entity.getWorldTransform().transformPoint(new Vec3(...this.boundsCenter));
    const scale = this.entity.getWorldTransform().getScale(new Vec3());
    return {
      center: [center.x, center.y, center.z],
      radius: this.boundsRadius * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)),
    };
  }

  // #WDD-gpt 2026-08-16 - GS2Mesh vertices are converted back to Gaussian-local space once, then both display and light proxies follow every later scene transform exactly.
  syncTransform(source: Entity): void {
    const position = source.getPosition();
    const rotation = source.getRotation();
    const scale = source.getWorldTransform().getScale(new Vec3());
    this.entity.setPosition(position);
    this.entity.setRotation(rotation);
    this.entity.setLocalScale(scale);
    if (this.relightingEntity) {
      this.relightingEntity.setPosition(position);
      this.relightingEntity.setRotation(rotation);
      this.relightingEntity.setLocalScale(scale);
    }
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
    // #WDD-gpt 2026-08-16 - Keep the proxy free of editor ambient and self illumination so a point light's range remains a real zero-direct-light boundary.
    material.ambient = Color.BLACK;
    material.emissive = Color.BLACK;
    material.specular = Color.BLACK;
    material.gloss = 0;
    material.useLighting = true;
    // #WDD-gpt 2026-08-16 - Normals are globally oriented when the GS2Mesh object is installed; camera-facing two-sided flipping would reverse the physical light direction on inward-wound triangles.
    material.twoSidedLighting = false;
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
    entity.setPosition(this.entity.getPosition());
    entity.setRotation(this.entity.getRotation());
    entity.setLocalScale(this.entity.getLocalScale());
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
