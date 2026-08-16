/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRaw4D } from '../../features/gaussian/formats/raw4d/Raw4DParser';
import { Raw4DWasmExtractor } from '../../features/gaussian/formats/raw4d/Raw4DWasmExtractor';
import { Raw4DFrameSampler } from '../../features/gaussian/runtime/Raw4DFrameSampler';
import type { GS2MeshGaussianFieldInput } from './GS2MeshTypes';
import {
  extractMarchingCubesPreview,
  extractOpacitySurface,
  splatOpacityField,
  type GS2MeshOpacityCoreExports,
} from './gs2mesh-opacity.worker';

const fixturePath = process.env.GS2MESH_RAW4D_FIXTURE_PATH;
const fixtureTest = fixturePath ? it : it.skip;

describe('GS2Mesh real RAW4D opacity integration', () => {
  fixtureTest('samples a real current frame and extracts a finite mesh', async () => {
    const bytes = await readFile(fixturePath!);
    const exactBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const extractor = await Raw4DWasmExtractor.create();
    const asset = await parseRaw4D(new Blob([exactBuffer]), {
      sourceName: fixturePath!.split('/').at(-1),
      extractChunk: extractor.extract,
    });
    const sampler = new Raw4DFrameSampler(asset);
    sampler.sample(0);
    const source = sampler.properties;
    const stride = Math.max(1, Math.ceil(asset.splatCount / 20_000));
    const selected: number[] = [];
    for (let index = 0; index < asset.splatCount; index += stride) {
      if (source.opacity[index] >= 0.035) selected.push(index);
    }
    const positions = new Float32Array(selected.length * 3);
    const rotations = new Float32Array(selected.length * 4);
    const scales = new Float32Array(selected.length * 3);
    const colors = new Uint8Array(selected.length * 4);
    const opacities = new Float32Array(selected.length);
    const shC0 = 0.28209479177387814;
    for (let output = 0; output < selected.length; output += 1) {
      const index = selected[output];
      const positionOffset = output * 3;
      const rotationOffset = output * 4;
      positions.set([source.x[index], source.y[index], source.z[index]], positionOffset);
      rotations.set([
        source.rotationX[index], source.rotationY[index], source.rotationZ[index], source.rotationW[index],
      ], rotationOffset);
      scales.set([source.scaleX[index], source.scaleY[index], source.scaleZ[index]], positionOffset);
      colors.set([
        Math.round(Math.max(0, Math.min(1, 0.5 + source.colorR[index] * shC0)) * 255),
        Math.round(Math.max(0, Math.min(1, 0.5 + source.colorG[index] * shC0)) * 255),
        Math.round(Math.max(0, Math.min(1, 0.5 + source.colorB[index] * shC0)) * 255),
        255,
      ], output * 4);
      opacities[output] = source.opacity[index];
    }
    const input: GS2MeshGaussianFieldInput = {
      frame: 0,
      focus: [0, 0, 0],
      boundsMin: asset.bounds.min,
      boundsMax: asset.bounds.max,
      positions,
      rotations,
      scales,
      colors,
      opacities,
      views: [{
        position: [0, 0, Math.max(1, asset.bounds.max[2] + 1)],
        right: [1, 0, 0],
        up: [0, 1, 0],
        forward: [0, 0, -1],
        tanHalfFovX: 1,
        tanHalfFovY: 1,
      }],
      fieldResolution: 48,
      isoLevel: 0.28,
    };
    const coreBytes = await readFile(resolve('src/plugins/gs2mesh/wasm/gs2mesh_core.wasm'));
    const coreResult = await WebAssembly.instantiate(coreBytes, {});
    // #WDD-gpt 2026-08-15 - Keep a repeatable real-file acceptance path for direct Gaussian meshing regressions.
    const field = splatOpacityField(coreResult.instance.exports as GS2MeshOpacityCoreExports, input, 1);
    const preview = extractMarchingCubesPreview(field, input);
    // #WDD-gpt 2026-08-15 - Keep the real-file acceptance path for both loading-stage Marching Cubes and refined extraction.
    expect(preview.positions.length / 3).toBeGreaterThan(500);
    expect(preview.indices.length / 3).toBeGreaterThan(500);
    const mesh = extractOpacitySurface(field, input, 1);
    expect(selected.length).toBeGreaterThan(1_000);
    expect(mesh.positions.length / 3).toBeGreaterThan(1_000);
    expect(mesh.indices.length / 3).toBeGreaterThan(1_000);
    expect([...mesh.positions].every(Number.isFinite)).toBe(true);
    expect([...mesh.normals!].every(Number.isFinite)).toBe(true);
  }, 120_000);
});
