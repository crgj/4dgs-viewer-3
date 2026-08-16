export class KeyframeSlotCache {
  readonly slotKeys: Int32Array;
  private readonly pinnedKeys: ReadonlySet<number>;

  constructor(
    readonly keyCount: number,
    readonly slotCount: number,
    pinnedKeys: readonly number[] = [],
  ) {
    if (keyCount <= 0 || slotCount <= 0 || slotCount > 4 || slotCount > keyCount) {
      throw new Error('Keyframe slot cache requires 1..4 slots no greater than the key count.');
    }
    this.pinnedKeys = new Set(pinnedKeys);
    this.slotKeys = new Int32Array(slotCount);
    this.slotKeys.fill(-1);
  }

  initialize(upload: (slot: number, key: number) => void): void {
    const initial = [...this.pinnedKeys, ...Array.from({ length: this.keyCount }, (_, key) => key)]
      .filter((key, index, values) => values.indexOf(key) === index)
      .slice(0, this.slotCount);
    initial.forEach((key, slot) => {
      upload(slot, key);
      this.slotKeys[slot] = key;
    });
  }

  ensure(requiredKeys: readonly number[], upload: (slot: number, key: number) => void): boolean {
    const required = new Set(requiredKeys.filter((key) => key >= 0 && key < this.keyCount));
    for (const key of this.pinnedKeys) required.add(key);
    let changed = false;
    for (const key of required) {
      if (this.findSlot(key) >= 0) continue;
      const slot = this.findEvictionSlot(required);
      if (slot < 0) throw new Error(`No keyframe slot can admit key ${key}.`);
      upload(slot, key);
      this.slotKeys[slot] = key;
      changed = true;
    }
    return changed;
  }

  findSlot(key: number): number {
    return this.slotKeys.indexOf(key);
  }

  uniformKeys(): Float32Array {
    const result = new Float32Array(4);
    result.fill(-1);
    result.set(this.slotKeys);
    return result;
  }

  private findEvictionSlot(required: ReadonlySet<number>): number {
    for (let slot = 0; slot < this.slotKeys.length; slot += 1) {
      if (this.slotKeys[slot] < 0) return slot;
    }
    for (let slot = 0; slot < this.slotKeys.length; slot += 1) {
      const resident = this.slotKeys[slot];
      if (!required.has(resident) && !this.pinnedKeys.has(resident)) return slot;
    }
    return -1;
  }
}

export function keyframeRequirements(
  keyframes: readonly number[],
  frame: number,
  includePrefetch = true,
): number[] {
  if (keyframes.length === 1) return [0];
  let right = keyframes.findIndex((keyframe) => keyframe >= frame);
  if (right < 0) right = keyframes.length - 1;
  const left = Math.max(0, right - (keyframes[right] > frame ? 1 : 0));
  const result = [left, right];
  if (includePrefetch) result.push(Math.min(keyframes.length - 1, right + 1));
  return result.filter((key, index, values) => values.indexOf(key) === index);
}
