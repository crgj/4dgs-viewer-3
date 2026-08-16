import type { ViewportCameraView } from '../../features/viewport/runtime/ViewportRuntime';

type Vec3 = readonly [number, number, number];

interface ViewCubeFaceDefinition {
  readonly id: ViewportCameraView;
  readonly normal: Vec3;
  readonly vertices: readonly [Vec3, Vec3, Vec3, Vec3];
}

export interface ViewCubePoint {
  readonly x: number;
  readonly y: number;
}

export interface ProjectedViewCubeFace {
  readonly depth: number;
  readonly facing: number;
  readonly id: ViewportCameraView;
  readonly points: readonly [ViewCubePoint, ViewCubePoint, ViewCubePoint, ViewCubePoint];
}

const FACE_DEFINITIONS: readonly ViewCubeFaceDefinition[] = [
  { id: 'front', normal: [0, 0, 1], vertices: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { id: 'back', normal: [0, 0, -1], vertices: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { id: 'left', normal: [-1, 0, 0], vertices: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { id: 'right', normal: [1, 0, 0], vertices: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { id: 'top', normal: [0, 1, 0], vertices: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { id: 'bottom', normal: [0, -1, 0], vertices: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return length > 1e-8
    ? [value[0] / length, value[1] / length, value[2] / length]
    : [0, 0, 0];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function viewCubeDirection(yawDegrees: number, pitchDegrees: number): Vec3 {
  const yaw = yawDegrees * Math.PI / 180;
  const pitch = pitchDegrees * Math.PI / 180;
  const horizontal = Math.cos(pitch);
  return normalize([
    Math.sin(yaw) * horizontal,
    Math.sin(pitch),
    Math.cos(yaw) * horizontal,
  ]);
}

// #WDD-gpt 2026-08-16 - 以真实立方体顶点、透视除法和面法线背面剔除生成导航 Gizmo，而非 CSS 伪透视。
export function projectViewCubeFaces(
  width: number,
  height: number,
  yawDegrees: number,
  pitchDegrees: number,
): readonly ProjectedViewCubeFace[] {
  const viewDirection = viewCubeDirection(yawDegrees, pitchDegrees);
  const forward = normalize([-viewDirection[0], -viewDirection[1], -viewDirection[2]]);
  const upHint: Vec3 = Math.abs(viewDirection[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
  const right = normalize(cross(forward, upHint));
  const screenUp = normalize(cross(right, forward));
  const cameraDistance = 4.35;
  const cameraPosition: Vec3 = [
    viewDirection[0] * cameraDistance,
    viewDirection[1] * cameraDistance,
    viewDirection[2] * cameraDistance,
  ];
  const focalLength = Math.min(width, height) * 0.88;

  return FACE_DEFINITIONS
    .map((face): ProjectedViewCubeFace | null => {
      const facing = dot(face.normal, viewDirection);
      if (facing <= 0.001) return null;
      const points = face.vertices.map((vertex): ViewCubePoint => {
        const relative = subtract(vertex, cameraPosition);
        const depth = Math.max(0.1, dot(relative, forward));
        return {
          x: width * 0.5 + dot(relative, right) * focalLength / depth,
          y: height * 0.5 - dot(relative, screenUp) * focalLength / depth,
        };
      }) as [ViewCubePoint, ViewCubePoint, ViewCubePoint, ViewCubePoint];
      return {
        depth: face.vertices.reduce((sum, vertex) => sum + dot(vertex, viewDirection), 0) / 4,
        facing,
        id: face.id,
        points,
      };
    })
    .filter((face): face is ProjectedViewCubeFace => face !== null)
    .sort((a, b) => a.depth - b.depth);
}

function pointInPolygon(points: readonly ViewCubePoint[], x: number, y: number): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const a = points[current];
    const b = points[previous];
    const crosses = (a.y > y) !== (b.y > y)
      && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pickViewCubeFace(
  faces: readonly ProjectedViewCubeFace[],
  x: number,
  y: number,
): ViewportCameraView | null {
  for (let index = faces.length - 1; index >= 0; index -= 1) {
    if (pointInPolygon(faces[index].points, x, y)) return faces[index].id;
  }
  return null;
}

export function activeViewCubeFace(
  faces: readonly ProjectedViewCubeFace[],
): ViewportCameraView | null {
  const face = faces.reduce<ProjectedViewCubeFace | null>(
    (best, candidate) => !best || candidate.facing > best.facing ? candidate : best,
    null,
  );
  return face && face.facing > 0.9995 ? face.id : null;
}
