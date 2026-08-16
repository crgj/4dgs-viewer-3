import type {
  SmartAlignmentLandmark,
  SmartAlignmentVector3,
  SmartAlignmentViewAnalysis,
} from './SmartAlignmentTypes';

const VISIBILITY_THRESHOLD = 0.42;
const HEAD_INDICES = [0, 2, 5, 7, 8] as const;
const SHOULDER_INDICES = [11, 12] as const;
const HIP_INDICES = [23, 24] as const;
const FOOT_INDICES = [27, 28, 29, 30, 31, 32] as const;

interface Point2 {
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
}

export interface SmartAlignmentUpSolution {
  readonly unsignedWorldUp: SmartAlignmentVector3;
  readonly worldUp: SmartAlignmentVector3;
  readonly confidence: number;
  readonly directionalDominance: number;
  readonly hemisphereFlips: number;
  readonly opposingViews: number;
  readonly facesDetected: number;
  readonly semanticDominance: number;
  readonly semanticViewsUsed: number;
  readonly peopleCount: number;
  readonly viewsUsed: number;
}

export interface SmartAlignmentCenterSolution {
  readonly standingCenter: SmartAlignmentVector3;
  readonly confidence: number;
  readonly peopleCount: number;
  readonly viewsUsed: number;
}

const add = (a: SmartAlignmentVector3, b: SmartAlignmentVector3): SmartAlignmentVector3 => (
  [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
);

const scale = (value: SmartAlignmentVector3, factor: number): SmartAlignmentVector3 => (
  [value[0] * factor, value[1] * factor, value[2] * factor]
);

const dot = (a: SmartAlignmentVector3, b: SmartAlignmentVector3): number => (
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
);

const length = (value: SmartAlignmentVector3): number => Math.sqrt(dot(value, value));

const normalize = (value: SmartAlignmentVector3): SmartAlignmentVector3 | null => {
  const magnitude = length(value);
  return magnitude > 1e-6 ? scale(value, 1 / magnitude) : null;
};

function averageLandmarks(
  landmarks: readonly SmartAlignmentLandmark[],
  indices: readonly number[],
  visibilityThreshold = VISIBILITY_THRESHOLD,
): Point2 | null {
  const visible = indices
    .map((index) => landmarks[index])
    .filter((landmark): landmark is SmartAlignmentLandmark => (
      Boolean(landmark)
      && Number.isFinite(landmark.x)
      && Number.isFinite(landmark.y)
      && landmark.visibility >= visibilityThreshold
    ));
  if (visible.length === 0) return null;
  return {
    x: visible.reduce((sum, landmark) => sum + landmark.x, 0) / visible.length,
    y: visible.reduce((sum, landmark) => sum + landmark.y, 0) / visible.length,
    confidence: visible.reduce((sum, landmark) => sum + landmark.visibility, 0) / visible.length,
  };
}

function imageDeltaToWorld(
  view: SmartAlignmentViewAnalysis,
  dx: number,
  dy: number,
): SmartAlignmentVector3 | null {
  return normalize(add(
    scale(view.right, dx * view.horizontalSpan),
    scale(view.up, -dy * view.verticalSpan),
  ));
}

function poseUpVector(
  view: SmartAlignmentViewAnalysis,
  landmarks: readonly SmartAlignmentLandmark[],
): { vector: SmartAlignmentVector3; confidence: number } | null {
  const head = averageLandmarks(landmarks, HEAD_INDICES);
  const shoulders = averageLandmarks(landmarks, SHOULDER_INDICES);
  const hips = averageLandmarks(landmarks, HIP_INDICES);
  const feet = averageLandmarks(landmarks, FOOT_INDICES);
  const segments: Array<{ from: Point2; to: Point2; weight: number; minimumSpan: number }> = [];
  if (feet && head) segments.push({ from: feet, to: head, weight: 1, minimumSpan: 0.08 });
  if (feet && shoulders) segments.push({ from: feet, to: shoulders, weight: 0.72, minimumSpan: 0.065 });
  if (hips && shoulders) segments.push({ from: hips, to: shoulders, weight: 0.58, minimumSpan: 0.035 });

  let combined: SmartAlignmentVector3 = [0, 0, 0];
  let totalWeight = 0;
  for (const segment of segments) {
    const dx = segment.to.x - segment.from.x;
    const dy = segment.to.y - segment.from.y;
    if (Math.hypot(dx, dy) < segment.minimumSpan) continue;
    const direction = imageDeltaToWorld(view, dx, dy);
    if (!direction) continue;
    const confidence = Math.min(segment.from.confidence, segment.to.confidence);
    const weight = segment.weight * confidence;
    combined = add(combined, scale(direction, weight));
    totalWeight += weight;
  }
  const vector = normalize(combined);
  return vector && totalWeight > 0
    ? { vector, confidence: Math.min(1, totalWeight / 1.6) }
    : null;
}

function viewPoseObservations(view: SmartAlignmentViewAnalysis) {
  return view.poses
    .map((pose) => ({ pose, up: poseUpVector(view, pose.landmarks) }))
    .filter((value): value is { pose: (typeof view.poses)[number]; up: NonNullable<typeof value.up> } => (
      value.up !== null
    ));
}

function poseBodyCenter(landmarks: readonly SmartAlignmentLandmark[]): Point2 | null {
  const visible = landmarks.filter((landmark) => (
    Number.isFinite(landmark.x)
    && Number.isFinite(landmark.y)
    && landmark.visibility >= 0.35
  ));
  if (visible.length < 8) return null;
  const sortedX = visible.map(({ x }) => x).sort((a, b) => a - b);
  const sortedY = visible.map(({ y }) => y).sort((a, b) => a - b);
  const middle = Math.floor(visible.length / 2);
  const median = (values: readonly number[]) => values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) * 0.5
    : values[middle];
  const xSpan = sortedX[sortedX.length - 1] - sortedX[0];
  const ySpan = sortedY[sortedY.length - 1] - sortedY[0];
  return {
    x: median(sortedX),
    y: median(sortedY),
    confidence: Math.min(1, Math.max(xSpan, ySpan) / 0.25),
  };
}

function semanticHeadVote(
  view: SmartAlignmentViewAnalysis,
  worldAxis: SmartAlignmentVector3,
  peopleCount: number,
): { sign: number; weight: number } | null {
  if (view.faces.length === 0) return null;
  const bodies = viewPoseObservations(view)
    .sort((a, b) => b.up.confidence - a.up.confidence)
    .slice(0, Math.max(1, peopleCount))
    .flatMap(({ pose }) => {
      const center = poseBodyCenter(pose.landmarks);
      return center ? [{ center, pose }] : [];
    });
  if (bodies.length === 0) return null;

  let signedWeight = 0;
  let totalWeight = 0;
  for (const face of view.faces) {
    let closest = bodies[0];
    let closestDistance = Math.hypot(face.x - closest.center.x, face.y - closest.center.y);
    for (const body of bodies.slice(1)) {
      const distance = Math.hypot(face.x - body.center.x, face.y - body.center.y);
      if (distance < closestDistance) {
        closest = body;
        closestDistance = distance;
      }
    }
    if (closestDistance > 0.5) continue;
    const headDirection = imageDeltaToWorld(
      view,
      face.x - closest.center.x,
      face.y - closest.center.y,
    );
    if (!headDirection) continue;
    const agreement = dot(headDirection, worldAxis);
    if (Math.abs(agreement) < 0.2) continue;
    const weight = face.confidence * closest.center.confidence * Math.abs(agreement);
    signedWeight += Math.sign(agreement) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0
    ? { sign: Math.sign(signedWeight), weight: Math.abs(signedWeight) }
    : null;
}

// #WDD-gpt 2026-08-15 - 人数采用有效环绕视角的保守中位数，避免单张 Gaussian 残影被模型识别成第二个人。
export function estimateConsensusPeopleCount(
  views: readonly SmartAlignmentViewAnalysis[],
): number {
  const counts = views
    .map((view) => viewPoseObservations(view).length)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);
  return counts.length > 0 ? counts[Math.floor((counts.length - 1) / 2)] : 0;
}

// #WDD-gpt 2026-08-15 - 多视角只融合屏幕平面投影，避免依赖单张图像中不稳定的单目深度尺度。
export function solveSmartAlignmentUp(
  views: readonly SmartAlignmentViewAnalysis[],
): SmartAlignmentUpSolution | null {
  const viewDirections: Array<{ vector: SmartAlignmentVector3; weight: number }> = [];
  const peopleCount = estimateConsensusPeopleCount(views);
  let hemisphereFlips = 0;

  for (const view of views) {
    // #WDD-gpt 2026-08-15 - 每个视角只保留与共识人数相符的最高质量身体轴，丢弃低质量残影姿态。
    const observations = viewPoseObservations(view)
      .map(({ up }) => up)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, Math.max(1, peopleCount));
    if (observations.length === 0) continue;
    let viewDirection: SmartAlignmentVector3 = [0, 0, 0];
    let viewWeight = 0;
    for (const observation of observations) {
      viewDirection = add(viewDirection, scale(observation.vector, observation.confidence));
      viewWeight += observation.confidence;
    }
    const normalizedView = normalize(viewDirection);
    if (!normalizedView) continue;
    const meanWeight = viewWeight / observations.length;
    // #WDD-gpt 2026-08-15 - 将每个视角的有向头脚结果折叠为世界上半球身体轴，反向误识别只能贡献倾斜信息，不能触发 180 度翻转。
    const stableVector = normalizedView[1] >= 0 ? normalizedView : scale(normalizedView, -1);
    if (normalizedView[1] < 0) hemisphereFlips += 1;
    viewDirections.push({ vector: stableVector, weight: meanWeight });
  }

  if (viewDirections.length < 2) return null;
  // #WDD-gpt 2026-08-15 - 背面渲染偶尔会产生倒置姿态；以 55 度球面邻域寻找主方向簇，避免少数离群视角与正确结果相互抵消。
  const minimumAgreement = Math.cos(55 * (Math.PI / 180));
  let inliers: typeof viewDirections = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const seed of viewDirections) {
    const candidate = viewDirections.filter(({ vector }) => dot(seed.vector, vector) >= minimumAgreement);
    const score = candidate.reduce((sum, observation) => (
      sum + observation.weight * Math.max(0, dot(seed.vector, observation.vector))
    ), 0);
    if (score > bestScore) {
      bestScore = score;
      inliers = candidate;
    }
  }

  let combined: SmartAlignmentVector3 = [0, 0, 0];
  let totalWeight = 0;
  for (const observation of inliers) {
    combined = add(combined, scale(observation.vector, observation.weight));
    totalWeight += observation.weight;
  }
  const viewsUsed = inliers.length;
  const worldAxis = normalize(combined);
  if (!worldAxis || viewsUsed < 2 || totalWeight <= 0) return null;
  const consistency = length(combined) / totalWeight;
  const coverage = Math.min(1, viewsUsed / 8);
  const inlierRatio = viewsUsed / viewDirections.length;
  const allWeight = viewDirections.reduce((sum, observation) => sum + observation.weight, 0);
  const directionalDominance = allWeight > 0 ? totalWeight / allWeight : 0;
  const opposingViews = viewDirections.filter(({ vector }) => (
    dot(worldAxis, vector) <= -minimumAgreement
  )).length;
  let positiveHeadWeight = 0;
  let negativeHeadWeight = 0;
  let semanticViewsUsed = 0;
  for (const view of views) {
    const vote = semanticHeadVote(view, worldAxis, peopleCount);
    if (!vote || vote.sign === 0) continue;
    if (vote.sign > 0) positiveHeadWeight += vote.weight;
    else negativeHeadWeight += vote.weight;
    semanticViewsUsed += 1;
  }
  const semanticWeight = positiveHeadWeight + negativeHeadWeight;
  const facesDetected = views.reduce((sum, view) => sum + view.faces.length, 0);
  const semanticDominance = semanticWeight > 0
    ? Math.max(positiveHeadWeight, negativeHeadWeight) / semanticWeight
    : 0;
  // #WDD-gpt 2026-08-15 - 身体轴只决定倾斜角，独立人脸检测的多视角投票负责确定头端正负，禁止再用世界半球猜测头脚。
  const worldUp = negativeHeadWeight > positiveHeadWeight ? scale(worldAxis, -1) : worldAxis;
  return {
    unsignedWorldUp: worldAxis,
    worldUp,
    confidence: Math.max(0, Math.min(1, consistency * coverage * (0.7 + 0.3 * inlierRatio))),
    directionalDominance,
    hemisphereFlips,
    opposingViews,
    facesDetected,
    semanticDominance,
    semanticViewsUsed,
    peopleCount,
    viewsUsed,
  };
}

function solveLinear3(matrix: number[][], vector: number[]): SmartAlignmentVector3 | null {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-5) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index < 4; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index < 4; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return [augmented[0][3], augmented[1][3], augmented[2][3]];
}

// #WDD-gpt 2026-08-15 - 每个视角先求多人脚点均值，再以正交投影约束解三维中心，避免某一视图人数更多时产生权重偏差。
export function solveSmartAlignmentCenter(
  views: readonly SmartAlignmentViewAnalysis[],
): SmartAlignmentCenterSolution | null {
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
  const vector = [0, 0, 0];
  let confidenceSum = 0;
  let viewsUsed = 0;
  const peopleCount = estimateConsensusPeopleCount(views);

  for (const view of views) {
    const feet = viewPoseObservations(view)
      .sort((a, b) => b.up.confidence - a.up.confidence)
      .slice(0, Math.max(1, peopleCount))
      // #WDD-gpt 2026-08-15 - 脚点在半透明 Gaussian 边缘更易降置信度，仅在多视角中心求解阶段使用独立门限。
      .map(({ pose }) => averageLandmarks(pose.landmarks, FOOT_INDICES, 0.25))
      .filter((point): point is Point2 => point !== null);
    if (feet.length === 0) continue;
    const mean = {
      x: feet.reduce((sum, point) => sum + point.x, 0) / feet.length,
      y: feet.reduce((sum, point) => sum + point.y, 0) / feet.length,
      confidence: feet.reduce((sum, point) => sum + point.confidence, 0) / feet.length,
    };
    const projected = add(
      view.center,
      add(
        scale(view.right, (mean.x - 0.5) * view.horizontalSpan),
        scale(view.up, (0.5 - mean.y) * view.verticalSpan),
      ),
    );

    for (const axis of [view.right, view.up]) {
      const target = dot(axis, projected);
      for (let row = 0; row < 3; row += 1) {
        vector[row] += axis[row] * target;
        for (let column = 0; column < 3; column += 1) {
          matrix[row][column] += axis[row] * axis[column];
        }
      }
    }
    confidenceSum += mean.confidence;
    viewsUsed += 1;
  }

  const standingCenter = viewsUsed >= 2 ? solveLinear3(matrix, vector) : null;
  if (!standingCenter) return null;
  return {
    standingCenter,
    confidence: Math.min(1, confidenceSum / viewsUsed) * Math.min(1, viewsUsed / 3),
    peopleCount,
    viewsUsed,
  };
}
