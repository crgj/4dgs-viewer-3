export interface SurfacePointIndex {
  readonly cellSize: number;
  readonly maximumDistanceSquared: number;
  readonly buckets: ReadonlyMap<string, readonly number[]>;
  readonly points: Float32Array;
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length * 0.5)] ?? 0;
}

function gridNeighbors(
  values: Uint16Array,
  columns: number,
  rows: number,
  column: number,
  row: number,
): number[] {
  const neighbors: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    const y = row + dy;
    if (y < 0 || y >= rows) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = column + dx;
      if ((dx === 0 && dy === 0) || x < 0 || x >= columns) continue;
      const value = values[y * columns + x];
      if (value > 0) neighbors.push(value);
    }
  }
  return neighbors;
}

function removeDisparitySpeckles(values: Uint16Array, columns: number, rows: number): void {
  const visited = new Uint8Array(values.length);
  const queue = new Int32Array(values.length);
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] === 0 || visited[start] !== 0) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const current = queue[head++];
      const row = Math.floor(current / columns);
      const column = current - row * columns;
      const disparity = values[current];
      for (let dy = -1; dy <= 1; dy += 1) {
        const y = row + dy;
        if (y < 0 || y >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = column + dx;
          if ((dx === 0 && dy === 0) || x < 0 || x >= columns) continue;
          const neighbor = y * columns + x;
          const neighborDisparity = values[neighbor];
          const tolerance = Math.max(3, Math.min(disparity, neighborDisparity) * 0.16);
          if (
            neighborDisparity === 0
            || visited[neighbor] !== 0
            || Math.abs(neighborDisparity - disparity) > tolerance
          ) continue;
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    if (tail >= 7) continue;
    for (let index = 0; index < tail; index += 1) values[queue[index]] = 0;
  }
}

function directionalFill(
  values: Uint16Array,
  columns: number,
  rows: number,
  column: number,
  row: number,
): number {
  const candidates: number[] = [];
  const appendPair = (dx: number, dy: number): void => {
    let negative = 0;
    let positive = 0;
    for (let distance = 1; distance <= 4; distance += 1) {
      const negativeX = column - dx * distance;
      const negativeY = row - dy * distance;
      if (negative === 0 && negativeX >= 0 && negativeX < columns && negativeY >= 0 && negativeY < rows) {
        negative = values[negativeY * columns + negativeX];
      }
      const positiveX = column + dx * distance;
      const positiveY = row + dy * distance;
      if (positive === 0 && positiveX >= 0 && positiveX < columns && positiveY >= 0 && positiveY < rows) {
        positive = values[positiveY * columns + positiveX];
      }
      if (negative > 0 && positive > 0) break;
    }
    if (negative === 0 || positive === 0) return;
    const middle = (negative + positive) * 0.5;
    if (Math.abs(negative - positive) <= Math.max(3, middle * 0.14)) candidates.push(middle);
  };
  appendPair(1, 0);
  appendPair(0, 1);
  return candidates.length > 0 ? Math.round(median(candidates)) : 0;
}

export function refineDisparities(
  source: Uint16Array,
  foreground: Uint8Array,
  columns: number,
  rows: number,
): Uint16Array {
  const filtered = source.slice();
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const disparity = source[index];
      if (disparity === 0) continue;
      const neighbors = gridNeighbors(source, columns, rows, column, row);
      if (neighbors.length <= 1) {
        filtered[index] = 0;
        continue;
      }
      if (neighbors.length < 4) continue;
      const middle = median(neighbors);
      if (Math.abs(disparity - middle) > Math.max(3, middle * 0.12)) filtered[index] = 0;
    }
  }
  removeDisparitySpeckles(filtered, columns, rows);

  // #WDD-gpt 2026-08-15 - 只在 Gaussian 前景内迭代填补小视差孔洞，并要求邻域深度一致以避免跨轮廓拉面。
  let current = filtered;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const next = current.slice();
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        if (current[index] !== 0 || foreground[index] === 0) continue;
        const neighbors = gridNeighbors(current, columns, rows, column, row);
        if (neighbors.length >= 3) {
          const middle = median(neighbors);
          const spread = neighbors[neighbors.length - 1] - neighbors[0];
          if (spread <= Math.max(4, middle * 0.16)) next[index] = Math.round(middle);
        }
        if (next[index] === 0) next[index] = directionalFill(current, columns, rows, column, row);
      }
    }
    current = next;
  }
  return current;
}

function spatialKey(x: number, y: number, z: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
}

export function createSurfacePointIndex(points: Float32Array, sceneRadius: number): SurfacePointIndex | null {
  if (points.length < 3) return null;
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  let maximumZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.length; index += 3) {
    minimumX = Math.min(minimumX, points[index]);
    minimumY = Math.min(minimumY, points[index + 1]);
    minimumZ = Math.min(minimumZ, points[index + 2]);
    maximumX = Math.max(maximumX, points[index]);
    maximumY = Math.max(maximumY, points[index + 1]);
    maximumZ = Math.max(maximumZ, points[index + 2]);
  }
  const sampleDiagonal = Math.hypot(maximumX - minimumX, maximumY - minimumY, maximumZ - minimumZ);
  const maximumDistance = Math.max(
    1e-5,
    Math.min(sceneRadius / 20, Math.max(sceneRadius / 50, sampleDiagonal / 80)),
  );
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < points.length; index += 3) {
    const key = spatialKey(points[index], points[index + 1], points[index + 2], maximumDistance);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  }
  return {
    cellSize: maximumDistance,
    maximumDistanceSquared: maximumDistance * maximumDistance,
    buckets,
    points,
  };
}

export function isNearSurface(index: SurfacePointIndex | null, x: number, y: number, z: number): boolean {
  if (!index) return true;
  const cellX = Math.floor(x / index.cellSize);
  const cellY = Math.floor(y / index.cellSize);
  const cellZ = Math.floor(z / index.cellSize);
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const bucket = index.buckets.get(`${cellX + dx},${cellY + dy},${cellZ + dz}`);
        if (!bucket) continue;
        for (const point of bucket) {
          const offsetX = index.points[point] - x;
          const offsetY = index.points[point + 1] - y;
          const offsetZ = index.points[point + 2] - z;
          if (offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ <= index.maximumDistanceSquared) return true;
        }
      }
    }
  }
  return false;
}

interface BoundaryEdge {
  count: number;
  readonly first: number;
  readonly second: number;
}

export function fillSmallBoundaryHoles(
  positions: number[],
  colors: number[],
  indices: number[],
  maximumDiameter: number,
): number {
  const edges = new Map<string, BoundaryEdge>();
  const appendEdge = (first: number, second: number): void => {
    const key = first < second ? `${first},${second}` : `${second},${first}`;
    const existing = edges.get(key);
    if (existing) existing.count += 1;
    else edges.set(key, { count: 1, first, second });
  };
  for (let index = 0; index < indices.length; index += 3) {
    appendEdge(indices[index], indices[index + 1]);
    appendEdge(indices[index + 1], indices[index + 2]);
    appendEdge(indices[index + 2], indices[index]);
  }
  const adjacency = new Map<number, number[]>();
  for (const edge of edges.values()) {
    if (edge.count !== 1) continue;
    const first = adjacency.get(edge.first) ?? [];
    const second = adjacency.get(edge.second) ?? [];
    first.push(edge.second);
    second.push(edge.first);
    adjacency.set(edge.first, first);
    adjacency.set(edge.second, second);
  }
  const visited = new Set<string>();
  const edgeKey = (first: number, second: number): string => first < second ? `${first},${second}` : `${second},${first}`;
  let filled = 0;
  for (const [start, neighbors] of adjacency) {
    if (neighbors.length !== 2) continue;
    for (const firstNeighbor of neighbors) {
      if (visited.has(edgeKey(start, firstNeighbor))) continue;
      const loop = [start];
      let previous = start;
      let current = firstNeighbor;
      let closed = false;
      while (loop.length <= 64) {
        visited.add(edgeKey(previous, current));
        if (current === start) {
          closed = true;
          break;
        }
        loop.push(current);
        const nextNeighbors = adjacency.get(current);
        if (!nextNeighbors || nextNeighbors.length !== 2) break;
        const next = nextNeighbors[0] === previous ? nextNeighbors[1] : nextNeighbors[0];
        previous = current;
        current = next;
      }
      if (!closed || loop.length < 4 || loop.length > 64) continue;
      let minimumX = Number.POSITIVE_INFINITY;
      let minimumY = Number.POSITIVE_INFINITY;
      let minimumZ = Number.POSITIVE_INFINITY;
      let maximumX = Number.NEGATIVE_INFINITY;
      let maximumY = Number.NEGATIVE_INFINITY;
      let maximumZ = Number.NEGATIVE_INFINITY;
      let centerX = 0;
      let centerY = 0;
      let centerZ = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (const vertex of loop) {
        const offset = vertex * 3;
        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        minimumZ = Math.min(minimumZ, z);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
        maximumZ = Math.max(maximumZ, z);
        centerX += x;
        centerY += y;
        centerZ += z;
        red += colors[vertex * 4];
        green += colors[vertex * 4 + 1];
        blue += colors[vertex * 4 + 2];
      }
      const diameter = Math.hypot(maximumX - minimumX, maximumY - minimumY, maximumZ - minimumZ);
      if (diameter > maximumDiameter) continue;
      const divisor = loop.length;
      const center = positions.length / 3;
      positions.push(centerX / divisor, centerY / divisor, centerZ / divisor);
      colors.push(Math.round(red / divisor), Math.round(green / divisor), Math.round(blue / divisor), 255);
      for (let index = 0; index < loop.length; index += 1) {
        indices.push(loop[index], loop[(index + 1) % loop.length], center);
      }
      filled += 1;
    }
  }
  return filled;
}
