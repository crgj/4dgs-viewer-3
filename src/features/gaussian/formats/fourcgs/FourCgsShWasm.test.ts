import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { floatToHalf, halfToFloat } from '../../../../../scripts/fourcgs-prs-codec.mjs';

interface ShAssignCore extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly reset: () => void;
  readonly alloc: (bytes: number) => number;
  readonly assign_sh: (...parameters: number[]) => void;
}

describe('4CGS SH WASM assignment core', () => {
  it('matches the deterministic JavaScript tree labels and f64 errors', async () => {
    const bytes = await readFile(resolve('src/features/gaussian/formats/fourcgs/wasm/fourcgs_sh_assign.wasm'));
    const source = await WebAssembly.instantiate(bytes, {});
    const core = source.instance.exports as ShAssignCore;
    const rowCount = 257;
    const stride = 5;
    const levelCount = 2;
    const maximumDimensions = 2;
    const rows = new Uint16Array(rowCount * stride);
    for (let row = 0; row < rowCount; row += 1) {
      rows[row * stride + 1] = floatToHalf(((row * 17) % 97 - 48) / 64);
      rows[row * stride + 3] = floatToHalf(((row * 29) % 89 - 44) / 80);
      rows[row * stride + 4] = floatToHalf(((row * 43) % 83 - 41) / 72);
    }
    const shIndices = new Uint32Array([1, 3, 4]);
    const levelDimensions = new Uint32Array([0, 1, 1, 2]);
    const dimensionCounts = new Uint32Array([2, 2]);
    const nodeSplits = new Float32Array(levelCount * 255 * 2 * maximumDimensions);
    for (let level = 0; level < levelCount; level += 1) {
      for (let node = 0; node < 255; node += 1) {
        for (let side = 0; side < 2; side += 1) {
          for (let component = 0; component < maximumDimensions; component += 1) {
            nodeSplits[((level * 255 + node) * 2 + side) * maximumDimensions + component]
              = ((node * 7 + level * 13 + component * 19 + side * 5) % 61 - 30) / 48;
          }
        }
      }
    }
    const centers = new Float32Array(levelCount * 256 * maximumDimensions);
    for (let level = 0; level < levelCount; level += 1) {
      for (let label = 0; label < 256; label += 1) {
        for (let component = 0; component < maximumDimensions; component += 1) {
          centers[(level * 256 + label) * maximumDimensions + component]
            = ((label * 11 + level * 23 + component * 17) % 101 - 50) / 96;
        }
      }
    }

    core.reset();
    const rowsPointer = core.alloc(rows.byteLength);
    const shIndicesPointer = core.alloc(shIndices.byteLength);
    const levelDimensionsPointer = core.alloc(levelDimensions.byteLength);
    const dimensionCountsPointer = core.alloc(dimensionCounts.byteLength);
    const nodeSplitsPointer = core.alloc(nodeSplits.byteLength);
    const centersPointer = core.alloc(centers.byteLength);
    const labelsPointer = core.alloc(rowCount * levelCount);
    const squaredErrorsPointer = core.alloc(rowCount * Float64Array.BYTES_PER_ELEMENT);
    const maximumErrorsPointer = core.alloc(rowCount * Float32Array.BYTES_PER_ELEMENT);
    new Uint16Array(core.memory.buffer, rowsPointer, rows.length).set(rows);
    new Uint32Array(core.memory.buffer, shIndicesPointer, shIndices.length).set(shIndices);
    new Uint32Array(core.memory.buffer, levelDimensionsPointer, levelDimensions.length).set(levelDimensions);
    new Uint32Array(core.memory.buffer, dimensionCountsPointer, dimensionCounts.length).set(dimensionCounts);
    new Float32Array(core.memory.buffer, nodeSplitsPointer, nodeSplits.length).set(nodeSplits);
    new Float32Array(core.memory.buffer, centersPointer, centers.length).set(centers);
    core.assign_sh(
      rowsPointer, rowCount, stride, shIndicesPointer, levelDimensionsPointer, dimensionCountsPointer,
      nodeSplitsPointer, centersPointer, levelCount, maximumDimensions,
      labelsPointer, squaredErrorsPointer, maximumErrorsPointer,
    );

    const expectedLabels = new Uint8Array(rowCount * levelCount);
    const expectedSquaredErrors = new Float64Array(rowCount);
    const expectedMaximumErrors = new Float32Array(rowCount);
    // #WDD-gpt 2026-08-16 - 用与生产 JavaScript 回退相同的 f64 运算顺序逐项验证 WASM，防止临界标签或质量门漂移。
    for (let row = 0; row < rowCount; row += 1) {
      let squaredError = 0;
      let maximumError = 0;
      for (let level = 0; level < levelCount; level += 1) {
        const values = Array.from({ length: 2 }, (_, component) => {
          const dimension = levelDimensions[level * maximumDimensions + component];
          return halfToFloat(rows[row * stride + shIndices[dimension]]);
        });
        let node = 0;
        while (node < 255) {
          let leftDistance = 0;
          let rightDistance = 0;
          for (let component = 0; component < maximumDimensions; component += 1) {
            const left = nodeSplits[((level * 255 + node) * 2) * maximumDimensions + component];
            const right = nodeSplits[((level * 255 + node) * 2 + 1) * maximumDimensions + component];
            const leftDifference = values[component] - left;
            const rightDifference = values[component] - right;
            leftDistance += leftDifference * leftDifference;
            rightDistance += rightDifference * rightDifference;
          }
          node = leftDistance <= rightDistance ? node * 2 + 1 : node * 2 + 2;
        }
        const label = node - 255;
        expectedLabels[row * levelCount + level] = label;
        for (let component = 0; component < maximumDimensions; component += 1) {
          const difference = values[component]
            - centers[(level * 256 + label) * maximumDimensions + component];
          squaredError += difference * difference;
          maximumError = Math.max(maximumError, Math.abs(difference));
        }
      }
      expectedSquaredErrors[row] = squaredError;
      expectedMaximumErrors[row] = maximumError;
    }
    expect(new Uint8Array(core.memory.buffer, labelsPointer, expectedLabels.length)).toEqual(expectedLabels);
    expect(new Float64Array(core.memory.buffer, squaredErrorsPointer, rowCount)).toEqual(expectedSquaredErrors);
    expect(new Float32Array(core.memory.buffer, maximumErrorsPointer, rowCount)).toEqual(expectedMaximumErrors);
  });
});
