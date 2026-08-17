import type { GaussianEditStore } from '../../../gaussian/edit/GaussianEditStore';
import type { Raw4DAsset } from '../../../gaussian/formats/raw4d/Raw4DTypes';
import { readRaw4DScalar } from '../../../gaussian/formats/raw4d/Raw4DValues';

export type GaussianEnvelopeVector3 = readonly [number, number, number];

export interface GaussianEnvelopeMeshData {
  readonly activePointCount: number;
  readonly positions: Float32Array;
  readonly triangleIndices: Uint32Array;
  readonly edgeIndices: Uint32Array;
}

export interface GaussianEnvelopeSource {
  readonly asset: Raw4DAsset;
  readonly edits: GaussianEditStore;
}

interface GaussianEnvelopeSupport {
  readonly activePointCount: number;
  readonly maximum: [number, number, number];
  readonly minimum: [number, number, number];
  readonly offsets: Float64Array;
}

// #WDD-gpt 2026-08-16 - 26 个对称支撑方向形成稳定凸外包络，扫描复杂度固定且保证所有有效点位于网格内。
export const GAUSSIAN_ENVELOPE_DIRECTIONS: readonly GaussianEnvelopeVector3[] = (() => {
  const directions: GaussianEnvelopeVector3[] = [];
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        if (x === 0 && y === 0 && z === 0) continue;
        const inverseLength = 1 / Math.hypot(x, y, z);
        directions.push([x * inverseLength, y * inverseLength, z * inverseLength]);
      }
    }
  }
  return directions;
})();

function dot(first: GaussianEnvelopeVector3, second: GaussianEnvelopeVector3): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first: GaussianEnvelopeVector3, second: GaussianEnvelopeVector3): [number, number, number] {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalized(vector: GaussianEnvelopeVector3): [number, number, number] {
  const length = Math.hypot(...vector);
  return length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, 0, 0];
}

function addSupportPoint(support: GaussianEnvelopeSupport, point: GaussianEnvelopeVector3): void {
  for (let axis = 0; axis < 3; axis += 1) {
    support.minimum[axis] = Math.min(support.minimum[axis], point[axis]);
    support.maximum[axis] = Math.max(support.maximum[axis], point[axis]);
  }
  for (let directionIndex = 0; directionIndex < GAUSSIAN_ENVELOPE_DIRECTIONS.length; directionIndex += 1) {
    support.offsets[directionIndex] = Math.max(
      support.offsets[directionIndex],
      dot(GAUSSIAN_ENVELOPE_DIRECTIONS[directionIndex], point),
    );
  }
}

function emptySupport(activePointCount = 0): GaussianEnvelopeSupport {
  const offsets = new Float64Array(GAUSSIAN_ENVELOPE_DIRECTIONS.length);
  offsets.fill(Number.NEGATIVE_INFINITY);
  return {
    activePointCount,
    minimum: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    maximum: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    offsets,
  };
}

function intersectPlanes(
  firstNormal: GaussianEnvelopeVector3,
  firstOffset: number,
  secondNormal: GaussianEnvelopeVector3,
  secondOffset: number,
  thirdNormal: GaussianEnvelopeVector3,
  thirdOffset: number,
): [number, number, number] | null {
  const secondCrossThird = cross(secondNormal, thirdNormal);
  const determinant = dot(firstNormal, secondCrossThird);
  if (Math.abs(determinant) < 1e-9) return null;
  const thirdCrossFirst = cross(thirdNormal, firstNormal);
  const firstCrossSecond = cross(firstNormal, secondNormal);
  return [
    (firstOffset * secondCrossThird[0] + secondOffset * thirdCrossFirst[0] + thirdOffset * firstCrossSecond[0]) / determinant,
    (firstOffset * secondCrossThird[1] + secondOffset * thirdCrossFirst[1] + thirdOffset * firstCrossSecond[1]) / determinant,
    (firstOffset * secondCrossThird[2] + secondOffset * thirdCrossFirst[2] + thirdOffset * firstCrossSecond[2]) / determinant,
  ];
}

function buildGaussianEnvelopeMesh(support: GaussianEnvelopeSupport): GaussianEnvelopeMeshData | null {
  if (support.activePointCount === 0 || support.offsets.some((offset) => !Number.isFinite(offset))) return null;
  const diagonal = Math.hypot(
    support.maximum[0] - support.minimum[0],
    support.maximum[1] - support.minimum[1],
    support.maximum[2] - support.minimum[2],
  );
  const padding = Math.max(1e-5, diagonal * 0.0015);
  const offsets = Float64Array.from(support.offsets, (offset) => offset + padding);
  const tolerance = Math.max(1e-8, Math.max(diagonal, 1e-4) * 1e-6);
  const vertices: Array<[number, number, number]> = [];
  const directions = GAUSSIAN_ENVELOPE_DIRECTIONS;

  for (let first = 0; first < directions.length - 2; first += 1) {
    for (let second = first + 1; second < directions.length - 1; second += 1) {
      for (let third = second + 1; third < directions.length; third += 1) {
        const point = intersectPlanes(
          directions[first], offsets[first],
          directions[second], offsets[second],
          directions[third], offsets[third],
        );
        if (!point || directions.some((normal, index) => dot(normal, point) > offsets[index] + tolerance * 4)) continue;
        if (vertices.some((existing) => {
          const dx = existing[0] - point[0];
          const dy = existing[1] - point[1];
          const dz = existing[2] - point[2];
          return dx * dx + dy * dy + dz * dz <= tolerance * tolerance * 16;
        })) continue;
        vertices.push(point);
      }
    }
  }
  if (vertices.length < 4) return null;

  const triangleIndices: number[] = [];
  const edgeIndices: number[] = [];
  const edges = new Set<string>();
  for (let planeIndex = 0; planeIndex < directions.length; planeIndex += 1) {
    const normal = directions[planeIndex];
    const face = vertices.map((point, index) => ({ point, index })).filter(
      ({ point }) => Math.abs(dot(normal, point) - offsets[planeIndex]) <= tolerance * 8,
    );
    if (face.length < 3) continue;
    const center: [number, number, number] = [0, 0, 0];
    for (const { point } of face) {
      center[0] += point[0]; center[1] += point[1]; center[2] += point[2];
    }
    center[0] /= face.length; center[1] /= face.length; center[2] /= face.length;
    const reference: GaussianEnvelopeVector3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const axisU = normalized(cross(reference, normal));
    const axisV = cross(normal, axisU);
    face.sort((left, right) => {
      const leftOffset: GaussianEnvelopeVector3 = [
        left.point[0] - center[0], left.point[1] - center[1], left.point[2] - center[2],
      ];
      const rightOffset: GaussianEnvelopeVector3 = [
        right.point[0] - center[0], right.point[1] - center[1], right.point[2] - center[2],
      ];
      return Math.atan2(dot(leftOffset, axisV), dot(leftOffset, axisU))
        - Math.atan2(dot(rightOffset, axisV), dot(rightOffset, axisU));
    });
    for (let index = 1; index < face.length - 1; index += 1) {
      triangleIndices.push(face[0].index, face[index].index, face[index + 1].index);
    }
    for (let index = 0; index < face.length; index += 1) {
      const first = face[index].index;
      const second = face[(index + 1) % face.length].index;
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      if (edges.has(key)) continue;
      edges.add(key);
      edgeIndices.push(first, second);
    }
  }
  if (triangleIndices.length === 0) return null;
  return {
    activePointCount: support.activePointCount,
    positions: Float32Array.from(vertices.flat()),
    triangleIndices: Uint32Array.from(triangleIndices),
    edgeIndices: Uint32Array.from(edgeIndices),
  };
}

export function createGaussianEnvelopeMeshFromPoints(
  points: readonly GaussianEnvelopeVector3[],
): GaussianEnvelopeMeshData | null {
  const support = emptySupport(points.length);
  for (const point of points) addSupportPoint(support, point);
  return buildGaussianEnvelopeMesh(support);
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

// #WDD-gpt 2026-08-16 - 零拷贝分块扫描 Canonical 轨迹和删除位集，避免 Worker 复制数百 MB 属性数据。
export async function computeGaussianEnvelopeMesh(
  sources: readonly GaussianEnvelopeSource[],
  shouldCancel: () => boolean = () => false,
): Promise<GaussianEnvelopeMeshData | null> {
  let activePointCount = 0;
  const support = emptySupport();
  let processedSinceYield = 0;
  for (const { asset, edits } of sources) {
    const position = asset.position;
    for (let stableId = 0; stableId < asset.splatCount; stableId += 1) {
      if (edits.isDeleted(stableId)) continue;
      activePointCount += 1;
      for (let keyframe = 0; keyframe < position.keyframes.length; keyframe += 1) {
        const offset = keyframe * position.components;
        addSupportPoint(support, [
          readRaw4DScalar(position.values[offset], stableId, position.encoding),
          readRaw4DScalar(position.values[offset + 1], stableId, position.encoding),
          readRaw4DScalar(position.values[offset + 2], stableId, position.encoding),
        ]);
      }
      processedSinceYield += 1;
      if (processedSinceYield >= 2048) {
        if (shouldCancel()) throw new DOMException('Gaussian envelope calculation cancelled.', 'AbortError');
        processedSinceYield = 0;
        await yieldToBrowser();
      }
    }
  }
  if (shouldCancel()) throw new DOMException('Gaussian envelope calculation cancelled.', 'AbortError');
  return buildGaussianEnvelopeMesh({ ...support, activePointCount });
}
