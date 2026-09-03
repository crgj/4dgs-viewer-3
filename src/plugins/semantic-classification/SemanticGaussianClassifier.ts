import type {
  SemanticClassSummary,
  SemanticTag,
  SemanticViewMask,
} from './SemanticClassificationTypes';

export interface SemanticGaussianProjectionInput {
  readonly positions: Float32Array;
  readonly opacities: Float32Array;
  readonly frames?: readonly SemanticGaussianProjectionFrame[];
  readonly deletedWords: Uint32Array;
  readonly tags: readonly SemanticTag[];
  readonly views: readonly SemanticViewMask[];
  /** 高可信三维传播种子的最低原始 CLIPSeg 概率。 */
  readonly threshold: number;
  readonly occlusionTolerance: number;
}

export interface SemanticGaussianProjectionFrame {
  readonly frame: number;
  readonly positions: Float32Array;
  readonly opacities: Float32Array;
}

export interface SemanticGaussianProjectionResult {
  readonly classIds: Uint16Array;
  readonly confidences: Uint8Array;
  readonly activePointCount: number;
  readonly deletedPointCount: number;
  readonly directCount: number;
  readonly propagatedCount: number;
  readonly classifiedCount: number;
  readonly meanConfidence: number;
  readonly classes: readonly SemanticClassSummary[];
}

interface SemanticSeedCell {
  readonly scores: Float32Array;
  weight: number;
}

interface SemanticMaskCalibration {
  readonly low: Float32Array;
  readonly inverseRange: Float32Array;
}

function dot3(x: number, y: number, z: number, vector: readonly number[]): number {
  return x * vector[0] + y * vector[1] + z * vector[2];
}

function probabilityQuantile(histogram: Uint32Array, total: number, quantile: number): number {
  const target = Math.max(1, Math.ceil(total * quantile));
  let accumulated = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    accumulated += histogram[bin];
    if (accumulated >= target) return bin / (histogram.length - 1);
  }
  return 1;
}

// #WDD-gpt 2026-08-27 - CLIPSeg 各文字 Prompt 是独立二分类头，原始概率不可直接横向比较；按每张图每个 Prompt 的稳健分位数消除整体偏置。
function buildMaskCalibration(view: SemanticViewMask, tagCount: number): SemanticMaskCalibration {
  const pixelCount = view.width * view.height;
  const low = new Float32Array(tagCount);
  const inverseRange = new Float32Array(tagCount);
  if (pixelCount < 64) {
    inverseRange.fill(1);
    return { low, inverseRange };
  }
  const bins = 256;
  for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
    const histogram = new Uint32Array(bins);
    const offset = tagIndex * pixelCount;
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const probability = Math.max(0, Math.min(1, view.probabilities[offset + pixel]));
      histogram[Math.min(bins - 1, Math.round(probability * (bins - 1)))] += 1;
    }
    const baseline = probabilityQuantile(histogram, pixelCount, 0.5);
    const high = probabilityQuantile(histogram, pixelCount, 0.98);
    low[tagIndex] = baseline;
    // 平坦概率图不生成伪高分；至少 0.025 的空间对比才允许成为分类证据。
    inverseRange[tagIndex] = high - baseline >= 0.025 ? 1 / (high - baseline) : 0;
  }
  return { low, inverseRange };
}

function sampleMask(
  view: SemanticViewMask,
  calibration: SemanticMaskCalibration,
  tagIndex: number,
  u: number,
  v: number,
): number {
  const x = Math.max(0, Math.min(view.width - 1, u * (view.width - 1)));
  const y = Math.max(0, Math.min(view.height - 1, v * (view.height - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(view.width - 1, x0 + 1);
  const y1 = Math.min(view.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const offset = tagIndex * view.width * view.height;
  const row0 = offset + y0 * view.width;
  const row1 = offset + y1 * view.width;
  const top = view.probabilities[row0 + x0] * (1 - tx) + view.probabilities[row0 + x1] * tx;
  const bottom = view.probabilities[row1 + x0] * (1 - tx) + view.probabilities[row1 + x1] * tx;
  const raw = top * (1 - ty) + bottom * ty;
  return Math.max(0, Math.min(1, (raw - calibration.low[tagIndex]) * calibration.inverseRange[tagIndex]));
}

function isDeleted(words: Uint32Array, stableId: number): boolean {
  return Boolean(words[stableId >>> 5] & (1 << (stableId & 31)));
}

function isFinitePoint(positions: Float32Array, stableId: number): boolean {
  const offset = stableId * 3;
  return Number.isFinite(positions[offset])
    && Number.isFinite(positions[offset + 1])
    && Number.isFinite(positions[offset + 2]);
}

function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function winnerFromScores(scores: ArrayLike<number>, tagCount: number): {
  winner: number;
  winnerScore: number;
  margin: number;
  total: number;
} {
  let winner = 0;
  let winnerScore = Number.NEGATIVE_INFINITY;
  let runnerUp = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
    const score = Number.isFinite(scores[tagIndex]) ? Math.max(0, scores[tagIndex]) : 0;
    total += score;
    if (score > winnerScore) {
      runnerUp = winnerScore;
      winnerScore = score;
      winner = tagIndex;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  const normalizedWinner = total > 1e-8 ? winnerScore / total : 0;
  const normalizedRunnerUp = tagCount <= 1 || total <= 1e-8 ? 0 : Math.max(0, runnerUp) / total;
  return { winner, winnerScore: Math.max(0, winnerScore), margin: normalizedWinner - normalizedRunnerUp, total };
}

function confidenceByte(rawProbability: number, relativeShare: number, evidence: number): number {
  const confidence = Math.max(0.01, Math.min(1,
    rawProbability * 0.55 + relativeShare * 0.35 + Math.min(1, evidence / 3) * 0.1,
  ));
  return Math.max(1, Math.min(255, Math.round(confidence * 255)));
}

// #WDD-gpt 2026-08-27 - 只允许高可信 CLIPSeg 种子进行局部三维传播；没有可靠种子时保留未识别，禁止全局多数类别制造错误点。
export function classifyProjectedGaussians(
  input: SemanticGaussianProjectionInput,
): SemanticGaussianProjectionResult {
  const pointCount = input.opacities.length;
  const tagCount = input.tags.length;
  if (input.positions.length !== pointCount * 3) throw new Error('Semantic position buffer size does not match opacity count.');
  if (tagCount === 0 || tagCount > 16) throw new Error('Semantic classification requires 1 to 16 tags.');
  if (input.views.length === 0) throw new Error('Semantic classification requires at least one view.');

  const scoreSums = new Float32Array(pointCount * tagCount);
  const supportSums = new Float32Array(pointCount);
  const supportedViews = new Uint8Array(pointCount);
  // #WDD-gpt 2026-08-27 - 只有在某个采样时间帧内实际可见且进入用户构图的点才允许分类，禁止用全局多数类别填满未出现的生命周期点。
  const eligible = new Uint8Array(pointCount);
  const positionSupport = new Uint8Array(pointCount);
  const positionSums = new Float32Array(pointCount * 3);
  const frameByIndex = new Map<number, SemanticGaussianProjectionFrame>();
  for (const frame of input.frames ?? []) {
    if (frame.positions.length !== pointCount * 3 || frame.opacities.length !== pointCount) {
      throw new Error(`Semantic frame ${frame.frame} buffer size does not match the point count.`);
    }
    frameByIndex.set(frame.frame, frame);
  }
  let activePointCount = 0;
  let deletedPointCount = 0;
  for (let stableId = 0; stableId < pointCount; stableId += 1) {
    if (isDeleted(input.deletedWords, stableId)) {
      deletedPointCount += 1;
      continue;
    }
    activePointCount += 1;
  }

  for (const view of input.views) {
    if (view.probabilities.length !== view.width * view.height * tagCount) {
      throw new Error(`Semantic mask ${view.id} has an invalid probability buffer.`);
    }
    const frame = frameByIndex.get(view.frame) ?? { frame: view.frame, positions: input.positions, opacities: input.opacities };
    const calibration = buildMaskCalibration(view, tagCount);
    const positions = frame.positions;
    const opacities = frame.opacities;
    const depth = new Float32Array(view.width * view.height);
    depth.fill(Number.POSITIVE_INFINITY);
    for (let stableId = 0; stableId < pointCount; stableId += 1) {
      if (isDeleted(input.deletedWords, stableId) || opacities[stableId] < 0.01
        || !isFinitePoint(positions, stableId)) continue;
      const offset = stableId * 3;
      const x = positions[offset] - view.center[0];
      const y = positions[offset + 1] - view.center[1];
      const z = positions[offset + 2] - view.center[2];
      const u = dot3(x, y, z, view.right) / view.horizontalSpan + 0.5;
      const v = 0.5 - dot3(x, y, z, view.up) / view.verticalSpan;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      eligible[stableId] = 1;
      positionSupport[stableId] = Math.min(255, positionSupport[stableId] + 1);
      positionSums[offset] += positions[offset];
      positionSums[offset + 1] += positions[offset + 1];
      positionSums[offset + 2] += positions[offset + 2];
      const pixelX = Math.max(0, Math.min(view.width - 1, Math.round(u * (view.width - 1))));
      const pixelY = Math.max(0, Math.min(view.height - 1, Math.round(v * (view.height - 1))));
      const pointDepth = dot3(x, y, z, view.forward);
      const pixel = pixelY * view.width + pixelX;
      if (pointDepth < depth[pixel]) depth[pixel] = pointDepth;
    }

    for (let stableId = 0; stableId < pointCount; stableId += 1) {
      if (isDeleted(input.deletedWords, stableId) || !isFinitePoint(positions, stableId)) continue;
      const alpha = opacities[stableId];
      if (!Number.isFinite(alpha) || alpha < 0.01) continue;
      const offset = stableId * 3;
      const x = positions[offset] - view.center[0];
      const y = positions[offset + 1] - view.center[1];
      const z = positions[offset + 2] - view.center[2];
      const u = dot3(x, y, z, view.right) / view.horizontalSpan + 0.5;
      const v = 0.5 - dot3(x, y, z, view.up) / view.verticalSpan;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const pixelX = Math.max(0, Math.min(view.width - 1, Math.round(u * (view.width - 1))));
      const pixelY = Math.max(0, Math.min(view.height - 1, Math.round(v * (view.height - 1))));
      const pointDepth = dot3(x, y, z, view.forward);
      if (pointDepth > depth[pixelY * view.width + pixelX] + input.occlusionTolerance) continue;
      // 平方根 alpha 避免高透明度核心完全压制头发、衣边等低 alpha 细节，同时仍降低飞点的影响。
      const weight = Math.max(0.08, Math.min(1, Math.sqrt(Math.max(0, alpha))));
      supportSums[stableId] += weight;
      supportedViews[stableId] += 1;
      for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
        scoreSums[tagIndex * pointCount + stableId] += sampleMask(view, calibration, tagIndex, u, v) * weight;
      }
    }
  }

  const classIds = new Uint16Array(pointCount);
  const confidences = new Uint8Array(pointCount);
  const directRawProbabilities = new Float32Array(pointCount);
  const directRelativeShares = new Float32Array(pointCount);
  const directMargins = new Float32Array(pointCount);
  const tagScratch = new Float32Array(tagCount);
  const seedCells = new Map<string, SemanticSeedCell>();
  const classificationPositions = input.positions.slice();
  const boundsMin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const boundsMax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let stableId = 0; stableId < pointCount; stableId += 1) {
    if (!eligible[stableId] || isDeleted(input.deletedWords, stableId)) continue;
    const offset = stableId * 3;
    const divisor = Math.max(1, positionSupport[stableId]);
    for (let axis = 0; axis < 3; axis += 1) {
      classificationPositions[offset + axis] = positionSums[offset + axis] / divisor;
      boundsMin[axis] = Math.min(boundsMin[axis], classificationPositions[offset + axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], classificationPositions[offset + axis]);
    }
  }
  const maximumSpan = Math.max(
    1e-5,
    boundsMax[0] - boundsMin[0],
    boundsMax[1] - boundsMin[1],
    boundsMax[2] - boundsMin[2],
  );
  // #WDD-gpt 2026-08-27 - 更细的局部体素并限制两层邻域，避免少量语义种子跨大块场景扩散成错误类别。
  const cellSize = maximumSpan / 64;
  const seedMinimumViews = Math.min(2, input.views.length);
  let directCount = 0;

  for (let stableId = 0; stableId < pointCount; stableId += 1) {
    if (isDeleted(input.deletedWords, stableId) || !eligible[stableId] || supportSums[stableId] <= 0) continue;
    for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
      tagScratch[tagIndex] = scoreSums[tagIndex * pointCount + stableId] / supportSums[stableId];
    }
    const result = winnerFromScores(tagScratch, tagCount);
    const relativeShare = result.total > 1e-8 ? result.winnerScore / result.total : 1 / tagCount;
    directRawProbabilities[stableId] = result.winnerScore;
    directRelativeShares[stableId] = relativeShare;
    directMargins[stableId] = result.margin;
    const reliable = supportedViews[stableId] >= seedMinimumViews
      && result.winnerScore >= input.threshold
      && (tagCount === 1 || result.margin >= 0.035);
    if (reliable) {
      classIds[stableId] = input.tags[result.winner].id;
      confidences[stableId] = confidenceByte(result.winnerScore, relativeShare, supportedViews[stableId]);
      directCount += 1;
    }
    // #WDD-gpt 2026-08-27 - 低置信可见点不能创建传播种子；真实 scene.4gs 曾在 directCount=0 时被旧逻辑全部扩散成背景。
    if (!reliable || !isFinitePoint(classificationPositions, stableId)) continue;
    const offset = stableId * 3;
    const cellX = Math.floor((classificationPositions[offset] - boundsMin[0]) / cellSize);
    const cellY = Math.floor((classificationPositions[offset + 1] - boundsMin[1]) / cellSize);
    const cellZ = Math.floor((classificationPositions[offset + 2] - boundsMin[2]) / cellSize);
    const key = cellKey(cellX, cellY, cellZ);
    let cell = seedCells.get(key);
    if (!cell) {
      cell = { scores: new Float32Array(tagCount), weight: 0 };
      seedCells.set(key, cell);
    }
    // 可靠点构成局部语义场，权重同时考虑类别间隔、视角支持和原始概率。
    const seedWeight = Math.max(0.0125, directMargins[stableId])
      * Math.min(3, supportedViews[stableId])
      * Math.max(0.2, result.winnerScore);
    cell.scores[result.winner] += seedWeight;
    cell.weight += seedWeight;
  }

  const spatialScores = new Float32Array(tagCount);
  for (let stableId = 0; stableId < pointCount; stableId += 1) {
    if (isDeleted(input.deletedWords, stableId) || !eligible[stableId] || classIds[stableId] !== 0) continue;
    spatialScores.fill(0);
    let spatialWeight = 0;
    if (seedCells.size > 0 && isFinitePoint(classificationPositions, stableId)) {
      const offset = stableId * 3;
      const cellX = Math.floor((classificationPositions[offset] - boundsMin[0]) / cellSize);
      const cellY = Math.floor((classificationPositions[offset + 1] - boundsMin[1]) / cellSize);
      const cellZ = Math.floor((classificationPositions[offset + 2] - boundsMin[2]) / cellSize);
      // 先找最近的有种子体素壳层；一旦找到就停止，避免远处大类别吞掉局部小结构。
      for (let radius = 0; radius <= 2 && spatialWeight <= 0; radius += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          for (let dy = -radius; dy <= radius; dy += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
              if (radius > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== radius) continue;
              const cell = seedCells.get(cellKey(cellX + dx, cellY + dy, cellZ + dz));
              if (!cell) continue;
              const distanceWeight = 1 / (1 + dx * dx + dy * dy + dz * dz);
              spatialWeight += cell.weight * distanceWeight;
              for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
                spatialScores[tagIndex] += cell.scores[tagIndex] * distanceWeight;
              }
            }
          }
        }
      }
    }

    // 三维补全必须先找到邻近可靠种子；点自身的低置信观测只能帮助种子判别，不能独立触发分类。
    if (spatialWeight <= 0) continue;
    const directEvidence = supportSums[stableId] > 0;
    if (directEvidence) {
      const directWeight = supportedViews[stableId] >= 2 ? 1.35 : 0.7;
      for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
        const directScore = scoreSums[tagIndex * pointCount + stableId] / supportSums[stableId];
        spatialScores[tagIndex] += directScore * directWeight;
      }
      spatialWeight += directWeight;
    }
    const result = winnerFromScores(spatialScores, tagCount);
    if (result.total <= 1e-8 || (tagCount > 1 && result.margin < 0.05)) continue;
    const winner = result.winner;
    const relativeShare = result.total > 1e-8 ? result.winnerScore / result.total : 1 / tagCount;
    const rawProbability = directEvidence ? directRawProbabilities[stableId] : relativeShare * 0.55;
    classIds[stableId] = input.tags[winner].id;
    confidences[stableId] = confidenceByte(rawProbability, relativeShare, supportedViews[stableId]) || 1;
  }

  const counts = new Uint32Array(tagCount);
  const confidenceSums = new Float64Array(tagCount);
  let classifiedCount = 0;
  let totalConfidence = 0;
  for (let stableId = 0; stableId < pointCount; stableId += 1) {
    if (isDeleted(input.deletedWords, stableId) || !eligible[stableId]) continue;
    const tagIndex = input.tags.findIndex((tag) => tag.id === classIds[stableId]);
    if (tagIndex < 0) continue;
    const confidence = confidences[stableId] / 255;
    counts[tagIndex] += 1;
    confidenceSums[tagIndex] += confidence;
    classifiedCount += 1;
    totalConfidence += confidence;
  }

  return {
    classIds,
    confidences,
    activePointCount,
    deletedPointCount,
    directCount,
    propagatedCount: Math.max(0, classifiedCount - directCount),
    classifiedCount,
    meanConfidence: classifiedCount > 0 ? totalConfidence / classifiedCount : 0,
    classes: input.tags.map((tag, index) => ({
      ...tag,
      count: counts[index],
      meanConfidence: counts[index] > 0 ? confidenceSums[index] / counts[index] : 0,
    })),
  };
}
