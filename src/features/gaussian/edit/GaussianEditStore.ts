import { GAUSSIAN_CANONICAL_PAGE_POINTS } from '../data/GaussianCanonicalDataset';

export type GaussianAttributeType = 'u8' | 'u16' | 'u32' | 'i32' | 'f32' | 'f64';
export type GaussianSelectionMode = 'replace' | 'add' | 'remove' | 'toggle';
export type GaussianAttributeArray = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

export interface GaussianAttributeDefinition {
  readonly name: string;
  readonly type: GaussianAttributeType;
  readonly components?: number;
  readonly sparse?: boolean;
  readonly residency?: 'cpu-only' | 'gpu-on-demand';
}

export interface GaussianEditEvent {
  readonly kind: 'deleted' | 'selection' | 'attribute';
  readonly stableIds?: readonly number[];
  readonly attribute?: string;
}

class DenseBitSet {
  readonly words: Uint32Array;

  constructor(readonly length: number) {
    this.words = new Uint32Array(Math.ceil(length / 32));
  }

  get(index: number): boolean {
    return Boolean(this.words[index >>> 5] & (1 << (index & 31)));
  }

  set(index: number, value: boolean): void {
    const word = index >>> 5;
    const mask = 1 << (index & 31);
    if (value) this.words[word] |= mask;
    else this.words[word] &= ~mask;
  }

  clear(): void {
    this.words.fill(0);
  }

  get count(): number {
    let total = 0;
    for (let word of this.words) {
      // #WDD-gpt  2026-08-16 - Kernighan 位计数避免为选择统计展开百万级布尔数组。
      while (word) {
        word &= word - 1;
        total += 1;
      }
    }
    return total;
  }

  get byteLength(): number {
    return this.words.byteLength;
  }
}

function createAttributeArray(type: GaussianAttributeType, length: number): GaussianAttributeArray {
  switch (type) {
    case 'u8': return new Uint8Array(length);
    case 'u16': return new Uint16Array(length);
    case 'u32': return new Uint32Array(length);
    case 'i32': return new Int32Array(length);
    case 'f32': return new Float32Array(length);
    case 'f64': return new Float64Array(length);
  }
}

function resizeAttributeArray(source: GaussianAttributeArray, length: number): GaussianAttributeArray {
  const result = createAttributeArray(
    source instanceof Uint8Array ? 'u8'
      : source instanceof Uint16Array ? 'u16'
        : source instanceof Uint32Array ? 'u32'
          : source instanceof Int32Array ? 'i32'
            : source instanceof Float32Array ? 'f32' : 'f64',
    length,
  );
  result.set(source.subarray(0, Math.min(source.length, length)) as never);
  return result;
}

interface DenseAttributePage {
  readonly kind: 'dense';
  values: GaussianAttributeArray;
}

interface SparseAttributePage {
  readonly kind: 'sparse';
  indices: Uint32Array;
  values: GaussianAttributeArray;
  length: number;
}

type AttributePage = DenseAttributePage | SparseAttributePage;

interface AttributeColumn {
  readonly definition: Required<Omit<GaussianAttributeDefinition, 'name'>> & { readonly name: string };
  readonly pages: Map<number, AttributePage>;
}

function binarySearch(indices: Uint32Array, length: number, target: number): { found: boolean; index: number } {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (indices[middle] < target) low = middle + 1;
    else high = middle;
  }
  return { found: low < length && indices[low] === target, index: low };
}

export class GaussianEditStore {
  private readonly deleted: DenseBitSet;
  private readonly selected: DenseBitSet;
  private readonly columns = new Map<string, AttributeColumn>();
  private readonly listeners = new Set<(event: GaussianEditEvent) => void>();

  constructor(
    readonly pointCount: number,
    readonly pageSize = GAUSSIAN_CANONICAL_PAGE_POINTS,
  ) {
    this.deleted = new DenseBitSet(pointCount);
    this.selected = new DenseBitSet(pointCount);
  }

  onChange(listener: (event: GaussianEditEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isDeleted(stableId: number): boolean {
    this.validateId(stableId);
    return this.deleted.get(stableId);
  }

  setDeleted(stableIds: readonly number[], deleted = true): void {
    for (const id of stableIds) {
      this.validateId(id);
      this.deleted.set(id, deleted);
    }
    this.emit({ kind: 'deleted', stableIds });
  }

  get deletionWords(): Uint32Array {
    return this.deleted.words;
  }

  get deletionCount(): number {
    return this.deleted.count;
  }

  get selectionWords(): Uint32Array {
    return this.selected.words;
  }

  get selectionCount(): number {
    return this.selected.count;
  }

  // #WDD-gpt  2026-08-16 - 删除历史只保存被操作的稳定 ID，撤销时无需复制整份百万点位集。
  selectedStableIds(includeDeleted = false): number[] {
    const stableIds: number[] = [];
    for (let stableId = 0; stableId < this.pointCount; stableId += 1) {
      if (this.selected.get(stableId) && (includeDeleted || !this.deleted.get(stableId))) stableIds.push(stableId);
    }
    return stableIds;
  }

  // #WDD-gpt  2026-08-16 - Del 只写入软删除位集并清空选择，原始 RAW4D 属性保留到保存压实阶段。
  markSelectedDeleted(): number {
    let markedCount = 0;
    for (let stableId = 0; stableId < this.pointCount; stableId += 1) {
      if (!this.selected.get(stableId)) continue;
      if (!this.deleted.get(stableId)) {
        this.deleted.set(stableId, true);
        markedCount += 1;
      }
    }
    this.selected.clear();
    if (markedCount > 0) this.emit({ kind: 'deleted' });
    this.emit({ kind: 'selection' });
    return markedCount;
  }

  isSelected(stableId: number): boolean {
    this.validateId(stableId);
    return this.selected.get(stableId);
  }

  select(stableIds: readonly number[], mode: GaussianSelectionMode = 'replace'): void {
    if (mode === 'replace') this.selected.clear();
    for (const id of stableIds) {
      this.validateId(id);
      const next = mode === 'remove' ? false : mode === 'toggle' ? !this.selected.get(id) : true;
      this.selected.set(id, next);
    }
    this.emit({ kind: 'selection', stableIds });
  }

  // #WDD-gpt  2026-08-16 - 全局反选直接遍历稳定 ID 位集，跳过已删除高斯且不展开额外百万级数组。
  invertUndeletedSelection(): number {
    let invertedCount = 0;
    for (let stableId = 0; stableId < this.pointCount; stableId += 1) {
      const deleted = this.deleted.get(stableId);
      this.selected.set(stableId, !deleted && !this.selected.get(stableId));
      if (!deleted) invertedCount += 1;
    }
    this.emit({ kind: 'selection' });
    return invertedCount;
  }

  defineAttribute(definition: GaussianAttributeDefinition): void {
    if (!definition.name || this.columns.has(definition.name)) {
      throw new Error(`Gaussian attribute "${definition.name}" already exists or is invalid.`);
    }
    const components = Math.max(1, Math.floor(definition.components ?? 1));
    this.columns.set(definition.name, {
      definition: {
        ...definition,
        components,
        sparse: definition.sparse ?? false,
        residency: definition.residency ?? 'cpu-only',
      },
      pages: new Map(),
    });
  }

  listAttributes(): readonly GaussianAttributeDefinition[] {
    return [...this.columns.values()].map((column) => ({ ...column.definition }));
  }

  getAttributeDefinition(name: string): GaussianAttributeDefinition | null {
    const definition = this.columns.get(name)?.definition;
    return definition ? { ...definition } : null;
  }

  deleteAttribute(name: string): boolean {
    const deleted = this.columns.delete(name);
    if (deleted) this.emit({ kind: 'attribute', attribute: name });
    return deleted;
  }

  setAttribute(name: string, stableId: number, input: number | readonly number[]): void {
    this.validateId(stableId);
    const column = this.requireColumn(name);
    const values = typeof input === 'number' ? [input] : input;
    if (values.length !== column.definition.components) {
      throw new Error(`Gaussian attribute "${name}" requires ${column.definition.components} components.`);
    }
    const pageIndex = Math.floor(stableId / this.pageSize);
    const localIndex = stableId % this.pageSize;
    let page = column.pages.get(pageIndex);
    if (!page) {
      if (column.definition.sparse) {
        page = {
          kind: 'sparse',
          indices: new Uint32Array(8),
          values: createAttributeArray(column.definition.type, 8 * column.definition.components),
          length: 0,
        };
      } else {
        const pagePoints = Math.min(this.pageSize, this.pointCount - pageIndex * this.pageSize);
        page = {
          kind: 'dense',
          values: createAttributeArray(column.definition.type, pagePoints * column.definition.components),
        };
      }
      column.pages.set(pageIndex, page);
    }
    if (page.kind === 'dense') {
      page.values.set(values, localIndex * column.definition.components);
    } else {
      const location = binarySearch(page.indices, page.length, localIndex);
      let target = location.index;
      if (!location.found) {
        if (page.length === page.indices.length) {
          const capacity = Math.max(8, page.length * 2);
          const indices = new Uint32Array(capacity);
          indices.set(page.indices);
          page.indices = indices;
          page.values = resizeAttributeArray(page.values, capacity * column.definition.components);
        }
        page.indices.copyWithin(target + 1, target, page.length);
        page.values.copyWithin(
          (target + 1) * column.definition.components,
          target * column.definition.components,
          page.length * column.definition.components,
        );
        page.indices[target] = localIndex;
        page.length += 1;
      }
      page.values.set(values, target * column.definition.components);
    }
    this.emit({ kind: 'attribute', stableIds: [stableId], attribute: name });
  }

  getAttribute(name: string, stableId: number): readonly number[] | null {
    this.validateId(stableId);
    const column = this.requireColumn(name);
    const pageIndex = Math.floor(stableId / this.pageSize);
    const localIndex = stableId % this.pageSize;
    const page = column.pages.get(pageIndex);
    if (!page) return null;
    let valueIndex = localIndex;
    if (page.kind === 'sparse') {
      const location = binarySearch(page.indices, page.length, localIndex);
      if (!location.found) return null;
      valueIndex = location.index;
    }
    const first = valueIndex * column.definition.components;
    return Array.from(page.values.subarray(first, first + column.definition.components));
  }

  get byteLength(): number {
    let total = this.deleted.byteLength + this.selected.byteLength;
    for (const column of this.columns.values()) {
      for (const page of column.pages.values()) {
        total += page.values.byteLength;
        if (page.kind === 'sparse') total += page.indices.byteLength;
      }
    }
    return total;
  }

  private requireColumn(name: string): AttributeColumn {
    const column = this.columns.get(name);
    if (!column) throw new Error(`Gaussian attribute "${name}" is not defined.`);
    return column;
  }

  private validateId(stableId: number): void {
    if (!Number.isSafeInteger(stableId) || stableId < 0 || stableId >= this.pointCount) {
      throw new RangeError(`Gaussian stable ID ${stableId} is outside 0..${this.pointCount - 1}.`);
    }
  }

  private emit(event: GaussianEditEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
