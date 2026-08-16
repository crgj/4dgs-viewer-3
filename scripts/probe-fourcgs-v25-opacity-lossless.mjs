import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants, brotliCompressSync, deflateSync } from 'node:zlib';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, sha256 } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

function manifestFromContainer(bytes) {
  const length = bytes.readUInt32LE(8);
  return JSON.parse(bytes.subarray(12, 12 + length).toString('utf8'));
}

function temporalOpacity(segments, layout) {
  const valueCount = segments.reduce((sum, segment, index) => (
    sum + bankCount(segment, 'opacity_bank') * layout.activeSlots[index].length
  ), 0);
  const values = new Uint16Array(valueCount);
  const state = new Uint16Array(layout.slotCount);
  const initialized = new Uint8Array(layout.slotCount);
  let destination = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    for (let bank = 0; bank < bankCount(segment, 'opacity_bank'); bank += 1) {
      const property = segment.propertyIndex.get(`opacity_bank_${bank}`);
      for (const slot of layout.activeSlots[segmentIndex]) {
        const local = inverse[slot];
        const value = segment.rows[local * segment.propertyNames.length + property];
        values[destination++] = initialized[slot] ? value ^ state[slot] : value;
        state[slot] = value;
        initialized[slot] = 1;
      }
    }
  }
  return Buffer.from(values.buffer);
}

function shuffle16(raw) {
  const values = raw.length / 2;
  const shuffled = Buffer.allocUnsafe(raw.length);
  for (let index = 0; index < values; index += 1) {
    shuffled[index] = raw[index * 2];
    shuffled[values + index] = raw[index * 2 + 1];
  }
  return shuffled;
}

function brotli(raw) {
  return brotliCompressSync(raw, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_LGWIN]: 24,
  } });
}

// #WDD-gpt 2026-08-16 - 对原始 FP16 Opacity 做永久 Track XOR 时序预测和字节重排，实测无损流能否守住 60M。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const containerPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const outputDirectory = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/v25_opacity_lossless');
  const names = (await readdir(sourceDirectory))
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  const segments = [];
  for (const name of names) segments.push(await readSegment(join(sourceDirectory, name)));
  const manifest = manifestFromContainer(await readFile(containerPath));
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, manifest.crop.center, manifest.crop.halfExtent);
  const raw = temporalOpacity(segments, layout);
  const shuffled = shuffle16(raw);
  const candidates = [
    { name: 'deflate', compression: 'deflate', stored: deflateSync(raw, { level: 9 }), raw },
    { name: 'brotli', compression: 'brotli', stored: brotli(raw), raw },
    { name: 'brotli-shuffle16', compression: 'brotli-shuffle16', stored: brotli(shuffled), raw },
  ];
  await mkdir(outputDirectory, { recursive: true });
  const report = {
    version: '4CGS V2.5 lossless Opacity entropy probe',
    rawBytes: raw.length,
    rawSha256: sha256(raw),
    candidates: [],
  };
  for (const candidate of candidates) {
    const path = join(outputDirectory, `${candidate.name}.bin`);
    await writeFile(path, candidate.stored);
    report.candidates.push({
      name: candidate.name,
      compression: candidate.compression,
      path,
      storedBytes: candidate.stored.length,
      storedBytesM: candidate.stored.length / 1_000_000,
      storedSha256: sha256(candidate.stored),
      rawBytes: raw.length,
      rawSha256: sha256(raw),
    });
  }
  const reportPath = join(outputDirectory, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, candidates: report.candidates }));
}

await main();
