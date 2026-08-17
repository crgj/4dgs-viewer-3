import { readFile } from 'node:fs/promises';
import { parseRaw4D } from '../../src/features/gaussian/formats/raw4d/Raw4DParser';
import { Raw4DWasmExtractor } from '../../src/features/gaussian/formats/raw4d/Raw4DWasmExtractor';
import { Raw4DFrameSampler } from '../../src/features/gaussian/runtime/Raw4DFrameSampler';
import type { GS2MeshGaussianFieldInput } from '../../src/plugins/gs2mesh/GS2MeshTypes';
import {
  extractMarchingCubesPreview,
  splatOpacityField,
  type GS2MeshOpacityCoreExports,
} from '../../src/plugins/gs2mesh/gs2mesh-opacity.worker';

// #WDD-gpt 2026-08-16 - Keep a renderer-independent real-file diagnostic for checking whether GS2Mesh winding points toward or away from its volume.
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: vite-node tools/relighting-reference/analyze-mesh.ts <file.raw4d|--synthetic>');

let splatCount = 1;
const selected: number[] = [];
let positions: Float32Array;
let rotations: Float32Array;
let scales: Float32Array;
let colors: Uint8Array;
let opacities: Float32Array;
let boundsMin: readonly [number, number, number];
let boundsMax: readonly [number, number, number];
if (sourcePath === '--synthetic') {
  selected.push(0);
  positions = new Float32Array([0, 0, 0]);
  rotations = new Float32Array([0, 0, 0, 1]);
  scales = new Float32Array([0.25, 0.25, 0.25]);
  colors = new Uint8Array([180, 180, 180, 255]);
  opacities = new Float32Array([0.95]);
  boundsMin = [-0.75, -0.75, -0.75];
  boundsMax = [0.75, 0.75, 0.75];
} else {
  const bytes = await readFile(sourcePath);
  const extractor = await Raw4DWasmExtractor.create();
  const asset = await parseRaw4D(new Blob([bytes]), {
    sourceName: sourcePath.split('/').at(-1),
    extractChunk: extractor.extract,
  });
  splatCount = asset.splatCount;
  const sampler = new Raw4DFrameSampler(asset);
  sampler.sample(0);
  const source = sampler.properties;
  const stride = Math.max(1, Math.ceil(asset.splatCount / 20_000));
  for (let index = 0; index < asset.splatCount; index += stride) {
    if (source.opacity[index] >= 0.035) selected.push(index);
  }
  positions = new Float32Array(selected.length * 3);
  rotations = new Float32Array(selected.length * 4);
  scales = new Float32Array(selected.length * 3);
  colors = new Uint8Array(selected.length * 4);
  opacities = new Float32Array(selected.length);
  for (let output = 0; output < selected.length; output += 1) {
    const index = selected[output];
    const positionOffset = output * 3;
    positions.set([source.x[index], source.y[index], source.z[index]], positionOffset);
    rotations.set([
      source.rotationX[index], source.rotationY[index], source.rotationZ[index], source.rotationW[index],
    ], output * 4);
    scales.set([source.scaleX[index], source.scaleY[index], source.scaleZ[index]], positionOffset);
    colors.set([180, 180, 180, 255], output * 4);
    opacities[output] = source.opacity[index];
  }
  boundsMin = asset.bounds.min;
  boundsMax = asset.bounds.max;
}
const input: GS2MeshGaussianFieldInput = {
  frame: 0,
  focus: [0, 0, 0],
  boundsMin,
  boundsMax,
  positions,
  rotations,
  scales,
  colors,
  opacities,
  views: [],
  fieldResolution: 96,
  isoLevel: 0.28,
};
const coreBytes = await readFile('src/plugins/gs2mesh/wasm/gs2mesh_core.wasm');
const core = await WebAssembly.instantiate(coreBytes, {});
const field = splatOpacityField(core.instance.exports as GS2MeshOpacityCoreExports, input, 1);
const mesh = extractMarchingCubesPreview(field, input);
const center = [0, 1, 2].map((axis) => {
  const values = Array.from({ length: mesh.positions.length / 3 }, (_, index) => mesh.positions[index * 3 + axis]);
  return (Math.min(...values) + Math.max(...values)) * 0.5;
});
let radialScore = 0;
let positive = 0;
let negative = 0;
for (let offset = 0; offset < mesh.positions.length; offset += 3) {
  const radial = [
    mesh.positions[offset] - center[0],
    mesh.positions[offset + 1] - center[1],
    mesh.positions[offset + 2] - center[2],
  ];
  const normal = [mesh.normals![offset], mesh.normals![offset + 1], mesh.normals![offset + 2]];
  const denominator = Math.hypot(...radial) * Math.hypot(...normal);
  if (denominator <= 1e-8) continue;
  const alignment = radial.reduce((sum, value, axis) => sum + value * normal[axis], 0) / denominator;
  radialScore += alignment;
  if (alignment >= 0) positive += 1;
  else negative += 1;
}
process.stdout.write(`${JSON.stringify({
  splats: splatCount,
  selected: selected.length,
  vertices: mesh.positions.length / 3,
  triangles: mesh.indices.length / 3,
  meanRadialAlignment: radialScore / Math.max(1, positive + negative),
  positive,
  negative,
}, null, 2)}\n`);
