import type { GS2MeshVector3 } from './GS2MeshTypes';

const EPSILON = 1e-8;

function subtract(left: GS2MeshVector3, right: GS2MeshVector3): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function add(left: GS2MeshVector3, right: GS2MeshVector3): [number, number, number] {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function scale(vector: GS2MeshVector3, scalar: number): [number, number, number] {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function dot(left: GS2MeshVector3, right: GS2MeshVector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: GS2MeshVector3, right: GS2MeshVector3): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalize(vector: GS2MeshVector3): [number, number, number] {
  const length = Math.hypot(...vector);
  if (length < EPSILON) throw new Error('Cannot normalize a zero-length camera vector.');
  return scale(vector, 1 / length);
}

export interface GS2MeshFocusEstimate {
  readonly focus: [number, number, number];
  readonly distance: number;
  readonly supportingPoints: number;
}

export function estimateGS2MeshFocus(
  origin: GS2MeshVector3,
  forwardInput: GS2MeshVector3,
  points: readonly GS2MeshVector3[],
  fallback: GS2MeshVector3,
): GS2MeshFocusEstimate {
  const forward = normalize(forwardInput);
  const candidates: Array<{ angularError: number; depth: number }> = [];
  for (const point of points) {
    if (!point.every(Number.isFinite)) continue;
    const offset = subtract(point, origin);
    const depth = dot(offset, forward);
    if (depth <= EPSILON) continue;
    const perpendicular = subtract(offset, scale(forward, depth));
    const angularError = dot(perpendicular, perpendicular) / Math.max(EPSILON, depth * depth);
    candidates.push({ angularError, depth });
  }

  candidates.sort((left, right) => left.angularError - right.angularError);
  const supportCount = Math.min(512, Math.max(16, Math.ceil(candidates.length * 0.01)));
  const support = candidates.slice(0, supportCount).sort((left, right) => left.depth - right.depth);
  let distance: number;
  if (support.length > 0) {
    const middle = Math.floor(support.length / 2);
    distance = support.length % 2 === 0
      ? (support[middle - 1].depth + support[middle].depth) * 0.5
      : support[middle].depth;
  } else {
    const projectedFallback = dot(subtract(fallback, origin), forward);
    distance = projectedFallback > EPSILON
      ? projectedFallback
      : Math.max(EPSILON, Math.hypot(...subtract(fallback, origin)));
  }

  return {
    focus: add(origin, scale(forward, distance)),
    distance,
    supportingPoints: support.length,
  };
}

export function rotateGS2MeshOffset(
  offset: GS2MeshVector3,
  axisInput: GS2MeshVector3,
  radians: number,
): [number, number, number] {
  const axis = normalize(axisInput);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return add(
    add(scale(offset, cosine), scale(cross(axis, offset), sine)),
    scale(axis, dot(axis, offset) * (1 - cosine)),
  );
}

export function perspectiveIntrinsics(
  width: number,
  height: number,
  fieldOfViewDegrees: number,
  horizontalFieldOfView: boolean,
): { fx: number; fy: number; cx: number; cy: number } {
  const fieldOfView = fieldOfViewDegrees * Math.PI / 180;
  const focal = horizontalFieldOfView
    ? width / (2 * Math.tan(fieldOfView * 0.5))
    : height / (2 * Math.tan(fieldOfView * 0.5));
  return { fx: focal, fy: focal, cx: width * 0.5, cy: height * 0.5 };
}
