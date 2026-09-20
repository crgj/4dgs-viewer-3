// #WDD-gpt 2026-09-20 - SH 熵流只解压一次，按永久 Track 分区并行重建；状态总内存不随分区倍增。
import { Buffer } from 'buffer';
import { unzlibSync } from 'fflate';
import { unshuffle16 } from './FourCgsRaw4DBundle';
import type { FourCgsManifest } from './FourCgsTypes';
export function prepareSharedSh(raw: Buffer, manifest: FourCgsManifest, halfToFloat: (bits: number) => number, shared = false) {
  const magic = raw.subarray(0, 8).toString('ascii');
  if (magic !== 'C5T1SH01' && magic !== 'C5T2SH01' && magic !== 'C5T3SH01') throw new Error('不支持的共享 SH 流。');
  const slotCount = raw.readUInt32LE(8);
  const instanceCount = raw.readUInt32LE(12);
  const segmentCount = raw.readUInt16LE(16);
  const dimensions = raw.readUInt8(18);
  const levels = raw.readUInt8(19);
  const baseBytes = raw.readUInt32LE(20);
  const maskBytes = raw.readUInt32LE(24);
  const labelBytes = raw.readUInt32LE(28);
  const hasExceptions = magic !== 'C5T1SH01';
  const headerBytes = hasExceptions ? 40 : 32;
  const exceptionMaskBytes = hasExceptions ? raw.readUInt32LE(32) : 0;
  const exceptionValueBytes = hasExceptions ? raw.readUInt32LE(36) : 0;
  if (slotCount !== manifest.slotCount || segmentCount !== manifest.segments.length || ![9, 24, 45].includes(dimensions)
    || levels < 1 || levels > 32 || (magic === 'C5T1SH01' && levels !== 5)
    || baseBytes !== dimensions * 2 + levels * 256 * dimensions * 2) {
    throw new Error('4CGS 共享 SH 元数据不一致。');
  }
  const baseOffset = headerBytes;
  const mean = new Float32Array(dimensions);
  for (let dimension = 0; dimension < dimensions; dimension += 1) mean[dimension] = halfToFloat(raw.readUInt16LE(baseOffset + dimension * 2));
  const codebookOffset = baseOffset + dimensions * 2;
  const codebooks = new Float32Array(levels * 256 * dimensions);
  for (let index = 0; index < codebooks.length; index += 1) codebooks[index] = halfToFloat(raw.readUInt16LE(codebookOffset + index * 2));
  const maskOffset = baseOffset + baseBytes;
  const labelOffset = maskOffset + maskBytes;
  const exceptionMaskOffset = labelOffset + labelBytes;
  const exceptionValueOffset = exceptionMaskOffset + exceptionMaskBytes;
  const updateMask = unzlibSync(raw.subarray(maskOffset, labelOffset));
  const updates = unzlibSync(raw.subarray(labelOffset, exceptionMaskOffset));
  const exceptionMask = hasExceptions
    ? unzlibSync(raw.subarray(exceptionMaskOffset, exceptionValueOffset))
    : new Uint8Array(Math.ceil(instanceCount / 8));
  const storedExceptionValues = hasExceptions
    ? unzlibSync(raw.subarray(exceptionValueOffset, exceptionValueOffset + exceptionValueBytes))
    : new Uint8Array(0);
  const exceptionValues = magic === 'C5T3SH01' ? unshuffle16(storedExceptionValues) : storedExceptionValues;
  if (updateMask.byteLength !== Math.ceil(instanceCount / 8) || updates.byteLength % levels !== 0
    || exceptionMask.byteLength !== Math.ceil(instanceCount / 8) || exceptionValues.byteLength % (dimensions * 2) !== 0
    || exceptionValueOffset + exceptionValueBytes !== raw.byteLength) {
    throw new Error('4CGS 共享 SH 压缩载荷长度不一致。');
  }
  const share = <T extends Uint8Array | Float32Array>(array: T): T => {
    if (!shared) return array;
    const buffer = new SharedArrayBuffer(array.byteLength);
    const result = array instanceof Float32Array ? new Float32Array(buffer) : new Uint8Array(buffer);
    result.set(array); return result as T;
  };
  return { slotCount, instanceCount, dimensions, levels, mean: share(mean), codebooks: share(codebooks),
    updateMask: share(updateMask), updates: share(updates), exceptionMask: share(exceptionMask), exceptionValues: share(exceptionValues) };
}
export type PreparedSharedSh = ReturnType<typeof prepareSharedSh>;
export function decodeSharedShPartition(prepared: PreparedSharedSh, manifest: FourCgsManifest, activeSlots: readonly Int32Array[],
  rows: readonly Uint16Array[], indices: readonly Map<string, number>[], floatToHalf: (value: number) => number,
  partitionIndex = 0, partitionCount = 1): void {
  if (!Number.isInteger(partitionCount) || partitionCount < 1 || !Number.isInteger(partitionIndex) || partitionIndex < 0 || partitionIndex >= partitionCount) throw new Error('Invalid SH partition.');
  const { slotCount, instanceCount, dimensions, levels, mean, codebooks, updateMask, updates, exceptionMask, exceptionValues } = prepared;
  const partitionSlots = Math.max(0, Math.ceil((slotCount - partitionIndex) / partitionCount));
  const initialized = new Uint8Array(partitionSlots);
  const decodedSh = new Uint16Array(partitionSlots * dimensions);
  const restOffsets = indices.map((properties, segmentIndex) => {
    const first = properties.get('f_rest_0');
    if (first === undefined) throw new Error(`4CGS 第 ${segmentIndex + 1} 段缺少 SH 属性。`);
    for (let dimension = 1; dimension < dimensions; dimension += 1) {
      if (properties.get(`f_rest_${dimension}`) !== first + dimension) throw new Error(`4CGS 第 ${segmentIndex + 1} 段 SH 属性不连续。`);
    }
    return first;
  });
  // #WDD-gpt 2026-09-20 - 每次模板更新只计算一次各级码本地址，保持浮点累加顺序。
  const bookOffsets = new Int32Array(levels);
  let instance = 0;
  let updateOffset = 0;
  let exceptionOffset = 0;
  // #WDD-gpt 2026-08-16 - 共享 SH 解码支持输入自训练的 5/10/15 级模板及逐实例稀疏 FP16 质量修正。
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const stride = indices[segmentIndex].size;
    const rowValues = rows[segmentIndex];
    const restOffset = restOffsets[segmentIndex];
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      const partitionSlot = Math.floor(slot / partitionCount);
      const shOffset = partitionSlot * dimensions;
      const rowOffset = row * stride + restOffset;
      const updated = (updateMask[instance >>> 3] & (1 << (instance & 7))) !== 0;
      const currentUpdateOffset = updateOffset;
      if (updated) updateOffset += levels;
      const hasException = (exceptionMask[instance >>> 3] & (1 << (instance & 7))) !== 0;
      const currentExceptionOffset = exceptionOffset;
      if (hasException) exceptionOffset += dimensions * 2;
      instance++;
      if (slot % partitionCount !== partitionIndex) continue;
      if (updated) initialized[partitionSlot] = 1;
      if (!initialized[partitionSlot]) throw new Error(`4CGS Track ${slot} 缺少 SH 初始化。`);
      if (updated) {
        for (let level = 0; level < levels; level++) bookOffsets[level] = (level * 256 + updates[currentUpdateOffset + level]) * dimensions;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
          let value = mean[dimension];
          for (let level = 0; level < levels; level += 1) {
            value += codebooks[bookOffsets[level] + dimension];
          }
          const bits = floatToHalf(value);
          decodedSh[shOffset + dimension] = bits;
          rowValues[rowOffset + dimension] = bits;
        }
      } else {
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
          rowValues[rowOffset + dimension] = decodedSh[shOffset + dimension];
        }
      }
      if (hasException) {
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
          rowValues[rowOffset + dimension] = exceptionValues[currentExceptionOffset + dimension * 2]
            | (exceptionValues[currentExceptionOffset + dimension * 2 + 1] << 8);
        }
      }
    }
  }
  if (instance !== instanceCount || updateOffset !== updates.length || exceptionOffset !== exceptionValues.length) {
    throw new Error('4CGS 共享 SH 长度不一致。');
  }
}
