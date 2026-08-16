import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { bankCount, buildSlotMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';

const MAGIC = '4CGSMG01';
const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function activeMask(slotToLocal) {
  const slotCount = slotToLocal[0].length;
  const bits = new Uint8Array(Math.ceil(slotCount * slotToLocal.length / 8));
  for (let segmentIndex = 0; segmentIndex < slotToLocal.length; segmentIndex += 1) {
    for (let slot = 0; slot < slotCount; slot += 1) {
      if (slotToLocal[segmentIndex][slot] < 0) continue;
      const bit = segmentIndex * slotCount + slot;
      bits[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return bits;
}

function temporalComponent(segments, slotToLocal, namesBySegment) {
  const valueCount = namesBySegment.reduce((sum, names, index) => sum + names.length * segments[index].count, 0);
  const values = new Uint16Array(valueCount);
  const state = new Uint16Array(slotToLocal[0].length);
  const initialized = new Uint8Array(slotToLocal[0].length);
  let destination = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = slotToLocal[segmentIndex];
    for (const name of namesBySegment[segmentIndex]) {
      const property = segment.propertyIndex.get(name);
      if (property === undefined) throw new Error(`Missing ${name} in ${segment.path}`);
      for (let slot = 0; slot < inverse.length; slot += 1) {
        const local = inverse[slot];
        if (local < 0) continue;
        const value = segment.rows[local * segment.propertyNames.length + property];
        values[destination++] = initialized[slot] ? value ^ state[slot] : value;
        state[slot] = value;
        initialized[slot] = 1;
      }
    }
  }
  if (destination !== values.length) throw new Error(`Temporal stream length mismatch: ${destination} != ${values.length}`);
  return Buffer.from(values.buffer);
}

function propertyName(prefix, bank, component) {
  return component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`;
}

function addStream(streams, name, raw, compression = 'deflate') {
  const stored = compression === 'deflate' ? deflateSync(raw, { level: 9 }) : raw;
  streams.push({
    name,
    compression,
    rawBytes: raw.length,
    storedBytes: stored.length,
    rawSha256: sha256(raw),
    storedSha256: sha256(stored),
    stored,
  });
}

function addTrackStreams(streams, segments, slotToLocal, prefix, components) {
  for (const component of components) {
    const names = segments.map((segment) => Array.from(
      { length: bankCount(segment, prefix) },
      (_, bank) => propertyName(prefix, bank, component),
    ));
    addStream(streams, `${prefix}:${component || 'value'}`, temporalComponent(segments, slotToLocal, names));
  }
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const sharedShPath = resolve(process.argv[3] ?? 'artifacts/fourcgs_ts_coresh5r_shared_trajectory_sweep_20260815.exact.bin');
  const outputPath = resolve(process.argv[4] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_simple_merge.4cgs');
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (entries.length !== 6) throw new Error(`Expected six RAW4D segments, found ${entries.length}.`);

  const segments = [];
  let sourceBytes = 0;
  for (const entry of entries) {
    const path = join(sourceDirectory, entry.name);
    segments.push(await readSegment(path));
    sourceBytes += (await stat(path)).size;
    console.log(JSON.stringify({ loaded: entry.name }));
  }
  const slots = buildSlotMaps(segments);
  const streams = [];
  addStream(streams, 'active_masks', Buffer.from(activeMask(slots.slotToLocal)));
  addTrackStreams(streams, segments, slots.slotToLocal, 'xyz_bank', ['x', 'y', 'z']);
  addTrackStreams(streams, segments, slots.slotToLocal, 'rot_bank', ['w', 'x', 'y', 'z']);
  addTrackStreams(streams, segments, slots.slotToLocal, 'f_dc_bank', ['0', '1', '2']);
  addTrackStreams(streams, segments, slots.slotToLocal, 'scale_bank', ['0', '1', '2']);
  addTrackStreams(streams, segments, slots.slotToLocal, 'opacity_bank', ['']);
  addStream(streams, 'lifetime_mu', temporalComponent(segments, slots.slotToLocal, segments.map(() => ['lifetime_mu'])));
  addStream(streams, 'lifetime_w', temporalComponent(segments, slots.slotToLocal, segments.map(() => ['lifetime_w'])));
  addStream(streams, 'coresh5r_shared', await readFile(sharedShPath), 'raw');

  const firstFrame = Number(entries[0].match[1]);
  const lastFrame = Number(entries.at(-1).match[2]);
  const manifest = {
    format: '4CGS',
    version: 1,
    codecName: 'CoRe4D-SimpleBoundaryMerge-LosslessNonSH-CoReSH5R',
    sourceDirectory,
    sourceBytes,
    slotCount: slots.slotCount,
    firstFrame,
    lastFrame,
    uniqueFrameCount: lastFrame - firstFrame + 1,
    boundaryPolicy: 'one-to-one conservative continuation; unmatched Gaussian remains birth/death',
    nonShPolicy: 'lossless source fp16 bits with temporal XOR and deflate',
    shPolicy: 'one shared ordinary CoReSH-5R codebook with exact label reuse',
    segments: entries.map((entry, index) => ({
      name: entry.name.replace(/\.raw4d$/, ''),
      firstFrame: Number(entry.match[1]),
      lastFrame: Number(entry.match[2]),
      gaussianCount: segments[index].count,
      totalFrames: Number(entry.match[2]) - Number(entry.match[1]) + 1,
      bankCounts: {
        position: bankCount(segments[index], 'xyz_bank'),
        rotation: bankCount(segments[index], 'rot_bank'),
        colorDc: bankCount(segments[index], 'f_dc_bank'),
        scale: bankCount(segments[index], 'scale_bank'),
        opacity: bankCount(segments[index], 'opacity_bank'),
      },
    })),
    matches: slots.matches.map((match) => ({
      previous: match.previous.split('/').at(-1),
      current: match.current.split('/').at(-1),
      matchedCount: match.matchedCount,
      matchedRatio: match.matchedRatio,
    })),
    streams: streams.map(({ stored, ...stream }) => stream),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(manifestBytes.length, 8);
  const container = Buffer.concat([prefix, manifestBytes, ...streams.map((stream) => stream.stored)]);
  await writeFile(outputPath, container);
  const report = {
    outputPath,
    outputBytes: container.length,
    sourceBytes,
    compressionRatio: sourceBytes / container.length,
    slotCount: slots.slotCount,
    uniqueFrameCount: manifest.uniqueFrameCount,
    matches: manifest.matches,
    streams: manifest.streams,
    containerSha256: sha256(container),
  };
  await writeFile(`${outputPath}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

// #WDD-gpt 2026-08-15 - 新基线只合并相邻重叠帧的可靠 Gaussian 轨迹，非 SH 保持位级无损，SH 使用普通共享 CoReSH-5R。
await main();
