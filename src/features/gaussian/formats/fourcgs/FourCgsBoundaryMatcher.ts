export interface FourCgsBoundaryAttributes {
  readonly count: number;
  readonly position: Float32Array;
  readonly rotation: Float32Array;
  readonly colorDc: Float32Array;
  readonly scale: Float32Array;
  readonly opacity: Float32Array;
}
export interface FourCgsBoundaryMatchLimits {
  readonly cellSize: number;
  readonly maxPositionDistance: number;
  readonly maxRotationAngle: number;
  readonly maxColorDistance: number;
  readonly maxScaleDistance: number;
  readonly maxOpacityDistance: number;
}

export interface FourCgsBoundaryMatchResult {
  readonly currentToPrevious: Int32Array;
  readonly matchedCount: number;
  readonly rejectedByAttributes: number;
  readonly conflictedCount: number;
}

interface Proposal {
  readonly currentIndex: number;
  readonly previousIndex: number;
  readonly score: number;
}

function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function vectorDistance(valuesA: Float32Array, indexA: number, valuesB: Float32Array, indexB: number, components: number): number {
  let square = 0;
  const offsetA = indexA * components;
  const offsetB = indexB * components;
  for (let component = 0; component < components; component += 1) {
    const difference = valuesA[offsetA + component] - valuesB[offsetB + component];
    square += difference * difference;
  }
  return Math.sqrt(square);
}

function maximumComponentDistance(
  valuesA: Float32Array,
  indexA: number,
  valuesB: Float32Array,
  indexB: number,
  components: number,
): number {
  let maximum = 0;
  const offsetA = indexA * components;
  const offsetB = indexB * components;
  for (let component = 0; component < components; component += 1) {
    maximum = Math.max(maximum, Math.abs(valuesA[offsetA + component] - valuesB[offsetB + component]));
  }
  return maximum;
}

function quaternionAngle(valuesA: Float32Array, indexA: number, valuesB: Float32Array, indexB: number): number {
  const offsetA = indexA * 4;
  const offsetB = indexB * 4;
  let dot = 0;
  let lengthA = 0;
  let lengthB = 0;
  for (let component = 0; component < 4; component += 1) {
    const valueA = valuesA[offsetA + component];
    const valueB = valuesB[offsetB + component];
    dot += valueA * valueB;
    lengthA += valueA * valueA;
    lengthB += valueB * valueB;
  }
  if (lengthA <= 1e-20 || lengthB <= 1e-20) return Math.PI;
  const cosine = Math.min(1, Math.abs(dot) / Math.sqrt(lengthA * lengthB));
  return 2 * Math.acos(cosine);
}

function validateBoundary(attributes: FourCgsBoundaryAttributes): void {
  const expectedLengths = [
    ['position', attributes.position.length, attributes.count * 3],
    ['rotation', attributes.rotation.length, attributes.count * 4],
    ['colorDc', attributes.colorDc.length, attributes.count * 3],
    ['scale', attributes.scale.length, attributes.count * 3],
    ['opacity', attributes.opacity.length, attributes.count],
  ] as const;
  for (const [name, length, expected] of expectedLengths) {
    if (length !== expected) throw new Error(`Invalid ${name} boundary length: ${length}; expected ${expected}.`);
  }
}

function passesAttributeLimits(
  previous: FourCgsBoundaryAttributes,
  previousIndex: number,
  current: FourCgsBoundaryAttributes,
  currentIndex: number,
  limits: FourCgsBoundaryMatchLimits,
): boolean {
  return quaternionAngle(previous.rotation, previousIndex, current.rotation, currentIndex) <= limits.maxRotationAngle
    && vectorDistance(previous.colorDc, previousIndex, current.colorDc, currentIndex, 3) <= limits.maxColorDistance
    && maximumComponentDistance(previous.scale, previousIndex, current.scale, currentIndex, 3) <= limits.maxScaleDistance
    && Math.abs(previous.opacity[previousIndex] - current.opacity[currentIndex]) <= limits.maxOpacityDistance;
}

export function matchFourCgsBoundary(
  previous: FourCgsBoundaryAttributes,
  current: FourCgsBoundaryAttributes,
  limits: FourCgsBoundaryMatchLimits,
): FourCgsBoundaryMatchResult {
  validateBoundary(previous);
  validateBoundary(current);
  if (!(limits.cellSize > 0) || !(limits.maxPositionDistance > 0)) {
    throw new Error('4CGS boundary matching requires positive spatial limits.');
  }

  // #WDD-gpt 2026-08-15 - 只建立跨段一对一续接，不合并同帧 Gaussian，避免改变原始拓扑。
  const cells = new Map<string, number[]>();
  for (let index = 0; index < previous.count; index += 1) {
    const offset = index * 3;
    const key = cellKey(
      Math.floor(previous.position[offset] / limits.cellSize),
      Math.floor(previous.position[offset + 1] / limits.cellSize),
      Math.floor(previous.position[offset + 2] / limits.cellSize),
    );
    const members = cells.get(key);
    if (members) members.push(index);
    else cells.set(key, [index]);
  }

  const proposals: Proposal[] = [];
  let rejectedByAttributes = 0;
  const radius = Math.max(1, Math.ceil(limits.maxPositionDistance / limits.cellSize));
  const maximumSquareDistance = limits.maxPositionDistance * limits.maxPositionDistance;
  for (let currentIndex = 0; currentIndex < current.count; currentIndex += 1) {
    const offset = currentIndex * 3;
    const x = current.position[offset];
    const y = current.position[offset + 1];
    const z = current.position[offset + 2];
    const cellX = Math.floor(x / limits.cellSize);
    const cellY = Math.floor(y / limits.cellSize);
    const cellZ = Math.floor(z / limits.cellSize);
    let bestPrevious = -1;
    let bestSquareDistance = maximumSquareDistance;
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const members = cells.get(cellKey(cellX + dx, cellY + dy, cellZ + dz));
          if (!members) continue;
          for (const previousIndex of members) {
            const previousOffset = previousIndex * 3;
            const differenceX = previous.position[previousOffset] - x;
            const differenceY = previous.position[previousOffset + 1] - y;
            const differenceZ = previous.position[previousOffset + 2] - z;
            const squareDistance = differenceX * differenceX + differenceY * differenceY + differenceZ * differenceZ;
            if (squareDistance <= bestSquareDistance) {
              bestSquareDistance = squareDistance;
              bestPrevious = previousIndex;
            }
          }
        }
      }
    }
    if (bestPrevious < 0) continue;
    if (!passesAttributeLimits(previous, bestPrevious, current, currentIndex, limits)) {
      rejectedByAttributes += 1;
      continue;
    }
    proposals.push({ currentIndex, previousIndex: bestPrevious, score: bestSquareDistance });
  }

  proposals.sort((a, b) => a.score - b.score);
  const currentToPrevious = new Int32Array(current.count);
  currentToPrevious.fill(-1);
  const previousClaimed = new Uint8Array(previous.count);
  let matchedCount = 0;
  let conflictedCount = 0;
  for (const proposal of proposals) {
    if (previousClaimed[proposal.previousIndex]) {
      conflictedCount += 1;
      continue;
    }
    previousClaimed[proposal.previousIndex] = 1;
    currentToPrevious[proposal.currentIndex] = proposal.previousIndex;
    matchedCount += 1;
  }
  return { currentToPrevious, matchedCount, rejectedByAttributes, conflictedCount };
}
