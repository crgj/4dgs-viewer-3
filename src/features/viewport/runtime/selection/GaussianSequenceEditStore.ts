import { GaussianEditStore, type GaussianSelectionMode } from '../../../gaussian/edit/GaussianEditStore';

export interface GaussianSequenceEditSegment {
  readonly id: string;
  readonly pointCount: number;
  readonly totalFrames: number;
}

export interface GaussianSequenceSelectedIds {
  readonly segmentIndex: number;
  readonly stableIds: readonly number[];
}

interface GaussianSequenceEditEntry extends GaussianSequenceEditSegment {
  readonly edits: GaussianEditStore;
}

// #WDD-gpt 2026-08-16 - 序列级位集让选择和软删除独立于当前 GPU 驻留段，切段或显存淘汰后仍可恢复。
export class GaussianSequenceEditStore {
  private readonly entries: readonly GaussianSequenceEditEntry[];
  private activeIndex = -1;

  constructor(segments: readonly GaussianSequenceEditSegment[]) {
    if (segments.length === 0) throw new Error('Gaussian sequence requires at least one segment.');
    this.entries = segments.map((segment, index) => {
      if (!segment.id) throw new Error(`Gaussian sequence segment ${index} has no id.`);
      if (!Number.isInteger(segment.pointCount) || segment.pointCount < 0) {
        throw new Error(`Gaussian sequence segment ${segment.id} has an invalid point count.`);
      }
      return {
        ...segment,
        edits: new GaussianEditStore(segment.pointCount),
      };
    });
  }

  get segmentCount(): number {
    return this.entries.length;
  }

  get totalFrames(): number {
    return this.entries.reduce((total, entry) => total + entry.totalFrames, 0);
  }

  get totalPointCount(): number {
    return this.entries.reduce((total, entry) => total + entry.pointCount, 0);
  }

  get activeSegmentIndex(): number {
    return this.activeIndex;
  }

  setActiveSegment(index: number): GaussianEditStore {
    this.validateSegmentIndex(index);
    this.activeIndex = index;
    return this.entries[index].edits;
  }

  segment(index: number): GaussianSequenceEditEntry {
    this.validateSegmentIndex(index);
    return this.entries[index];
  }

  editsForActiveSegment(): GaussianEditStore | null {
    return this.activeIndex < 0 ? null : this.entries[this.activeIndex].edits;
  }

  selectedCount(scope: 'visible' | 'global'): number {
    return this.entriesForScope(scope)
      .reduce((total, entry) => total + entry.edits.selectionCount, 0);
  }

  deletionCount(): number {
    return this.entries.reduce((total, entry) => total + entry.edits.deletionCount, 0);
  }

  activeUndeletedCount(): number {
    const active = this.editsForActiveSegment();
    return active ? Math.max(0, active.pointCount - active.deletionCount) : 0;
  }

  clearSelection(scope: 'visible' | 'global'): void {
    for (const entry of this.entriesForScope(scope)) entry.edits.select([], 'replace');
  }

  invertSelection(scope: 'visible' | 'global'): number {
    let invertedCount = 0;
    for (const entry of this.entriesForScope(scope)) {
      invertedCount += entry.edits.invertUndeletedSelection();
    }
    return invertedCount;
  }

  select(segmentIndex: number, stableIds: readonly number[], mode: GaussianSelectionMode): void {
    this.segment(segmentIndex).edits.select(stableIds, mode);
  }

  selectedStableIds(scope: 'visible' | 'global'): readonly GaussianSequenceSelectedIds[] {
    const result: GaussianSequenceSelectedIds[] = [];
    for (let segmentIndex = 0; segmentIndex < this.entries.length; segmentIndex += 1) {
      const entry = this.entries[segmentIndex];
      if (scope === 'visible' && segmentIndex !== this.activeIndex) continue;
      const stableIds = entry.edits.selectedStableIds();
      if (stableIds.length > 0) result.push({ segmentIndex, stableIds });
    }
    return result;
  }

  markSelectedDeleted(scope: 'visible' | 'global'): number {
    return this.entriesForScope(scope)
      .reduce((total, entry) => total + entry.edits.markSelectedDeleted(), 0);
  }

  private entriesForScope(scope: 'visible' | 'global'): readonly GaussianSequenceEditEntry[] {
    if (scope === 'global') return this.entries;
    return this.activeIndex < 0 ? [] : [this.entries[this.activeIndex]];
  }

  private validateSegmentIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) {
      throw new RangeError(`Gaussian sequence segment index ${index} is out of range.`);
    }
  }
}
