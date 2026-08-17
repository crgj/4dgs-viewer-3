import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { extractRawStream, labelsInSourceOrder } from './repack-coresh5r-temporal.mjs';
import {
  buildCroppedMortonLayout,
  encodePositions,
  encodeRotations,
  encodeScales,
  halfToFloat,
  sha256,
} from './fourcgs-prs-codec.mjs';
import { encodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';
import { encodeMixRq, packMixRqWindows } from './fourcgs-mixrq-codec.mjs';
import { encodeTemporalRq } from './fourcgs-temporal-rq-codec.mjs';
import { encodeTemporalAttribute } from './fourcgs-temporal-attribute-codec.mjs';
import { encodeSo3Rotations } from './fourcgs-so3-temporal-codec.mjs';

const MAGIC = '4CGSPRS2';
const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.(?:raw4d|ply4)$/i;
const SH_HEADER_BYTES = 20;
const SH_MEAN_BYTES = 45 * 2;
const SH_CODEBOOK_BYTES = 5 * 256 * 45 * 2;

function sourceKeyframeStrides(segment) {
  const dc = Number(segment.comments.get('features_dc_bank_keyframe_stride'));
  const value = (name, fallback) => {
    const parsed = Number(segment.comments.get(name) ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name} in ${segment.path}.`);
    return parsed;
  };
  return {
    position: value('xyz_bank_keyframe_stride'),
    rotation: value('rot_bank_keyframe_stride'),
    colorDc: value('features_dc_bank_keyframe_stride'),
    scale: value('scaling_bank_keyframe_stride', Number.isSafeInteger(dc) && dc > 0 ? dc : 1),
    opacity: value('opacity_bank_keyframe_stride', Number.isSafeInteger(dc) && dc > 0 ? dc : 1),
  };
}

function robustCenter(segment) {
  const axes = ['x', 'y', 'z'].map((component) => {
    const property = segment.propertyIndex.get(`xyz_bank_0_${component}`);
    const values = Array.from({ length: segment.count }, (_, local) => halfToFloat(
      segment.rows[local * segment.propertyNames.length + property],
    ));
    values.sort((a, b) => a - b);
    return values;
  });
  const bounds = axes.map((values) => [values[Math.round((values.length - 1) * 0.005)], values[Math.round((values.length - 1) * 0.995)]]);
  return { bounds, center: bounds.map(([minimum, maximum]) => (minimum + maximum) / 2) };
}

function activeMask(layout) {
  const bytes = new Uint8Array(Math.ceil(layout.slotCount * layout.slotToLocal.length / 8));
  for (let segmentIndex = 0; segmentIndex < layout.slotToLocal.length; segmentIndex += 1) {
    for (const slot of layout.activeSlots[segmentIndex]) {
      const bit = segmentIndex * layout.slotCount + slot;
      bytes[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return bytes;
}

function temporalComponent(segments, layout, namesBySegment) {
  const valueCount = namesBySegment.reduce((sum, names, index) => sum + names.length * layout.activeSlots[index].length, 0);
  const values = new Uint16Array(valueCount);
  const state = new Uint16Array(layout.slotCount);
  const initialized = new Uint8Array(layout.slotCount);
  let destination = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    for (const name of namesBySegment[segmentIndex]) {
      const property = segment.propertyIndex.get(name);
      if (property === undefined) throw new Error(`Missing ${name} in ${segment.path}`);
      for (const slot of layout.activeSlots[segmentIndex]) {
        const local = inverse[slot];
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

function addTrackStreams(streams, segments, layout, prefix, components) {
  for (const component of components) {
    const names = segments.map((segment) => Array.from(
      { length: bankCount(segment, prefix) },
      (_, bank) => propertyName(prefix, bank, component),
    ));
    addStream(streams, `${prefix}:${component || 'value'}`, temporalComponent(segments, layout, names));
  }
}

function trackVectors(segments, layout, prefix, components) {
  const bankCounts = segments.map((segment) => bankCount(segment, prefix));
  if (!bankCounts.every((count) => count === bankCounts[0])) {
    throw new Error(`MixRQ requires a stable ${prefix} bank count: ${bankCounts.join(', ')}`);
  }
  const dimensions = bankCounts[0] * components.length;
  const observationCount = layout.activeSlots.reduce((sum, slots) => sum + slots.length, 0);
  const bits = new Uint16Array(observationCount * dimensions);
  let observation = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    const indices = Array.from({ length: bankCounts[segmentIndex] }, (_, bank) => (
      components.map((component) => segment.propertyIndex.get(propertyName(prefix, bank, component)))
    )).flat();
    if (indices.some((index) => index === undefined)) throw new Error(`Missing ${prefix} MixRQ property in ${segment.path}`);
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = inverse[slot];
      const sourceOffset = local * segment.propertyNames.length;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        bits[observation * dimensions + dimension] = segment.rows[sourceOffset + indices[dimension]];
      }
      observation += 1;
    }
  }
  if (observation !== observationCount) throw new Error(`MixRQ observation mismatch: ${observation} != ${observationCount}`);
  return { bits, observationCount, dimensions, bankCounts };
}

function encodeWindowedMixRq(vectors, activeSlots, options) {
  const results = [];
  let observationOffset = 0;
  for (let segmentIndex = 0; segmentIndex < activeSlots.length; segmentIndex += 1) {
    const observationCount = activeSlots[segmentIndex].length;
    const first = observationOffset * vectors.dimensions;
    const last = (observationOffset + observationCount) * vectors.dimensions;
    results.push(encodeMixRq(vectors.bits.subarray(first, last), observationCount, vectors.dimensions, options));
    observationOffset += observationCount;
  }
  if (observationOffset !== vectors.observationCount) throw new Error('Windowed MixRQ observation count mismatch.');
  const encoded = packMixRqWindows(results);
  return {
    encoded,
    metrics: {
      observationCount: vectors.observationCount,
      dimensions: vectors.dimensions,
      levels: options.levels,
      transform: options.transform,
      maximumAllowedError: options.maximumError,
      encodedBytes: encoded.length,
      sourceBytes: vectors.bits.byteLength,
      compressionRatio: vectors.bits.byteLength / encoded.length,
      exceptionCount: results.reduce((sum, result) => sum + result.metrics.exceptionCount, 0),
      exceptionRatio: results.reduce((sum, result) => sum + result.metrics.exceptionCount, 0) / vectors.bits.length,
      windows: results.map((result, index) => ({ index, ...result.metrics })),
    },
  };
}

function exactSharedShStream(payload, segments, layout) {
  if (payload.subarray(0, 8).toString('ascii') !== 'RVQ5SH01') throw new Error('Unsupported source CoReSH-5R payload.');
  const sourceCount = payload.readUInt32LE(8);
  const compressedBytes = payload.readUInt32LE(16);
  const labelOffset = SH_HEADER_BYTES + SH_MEAN_BYTES + SH_CODEBOOK_BYTES;
  const labels = inflateSync(payload.subarray(labelOffset, labelOffset + compressedBytes));
  if (labels.length !== sourceCount * 5) throw new Error('Invalid source CoReSH-5R label count.');
  const labelSets = labelsInSourceOrder(segments, labels);
  const instanceCount = layout.activeSlots.reduce((sum, active) => sum + active.length, 0);
  const mask = new Uint8Array(Math.ceil(instanceCount / 8));
  const updates = new Uint8Array(instanceCount * 5);
  const state = new Uint8Array(layout.slotCount * 5);
  const initialized = new Uint8Array(layout.slotCount);
  let instance = 0;
  let updateCount = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const inverse = layout.slotToLocal[segmentIndex];
    const segmentLabels = labelSets[segmentIndex];
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = inverse[slot];
      const stateOffset = slot * 5;
      const current = segmentLabels.subarray(local * 5, local * 5 + 5);
      let changed = !initialized[slot];
      for (let level = 0; level < 5 && !changed; level += 1) changed = state[stateOffset + level] !== current[level];
      if (changed) {
        mask[instance >>> 3] |= 1 << (instance & 7);
        updates.set(current, updateCount * 5);
        state.set(current, stateOffset);
        initialized[slot] = 1;
        updateCount += 1;
      }
      instance += 1;
    }
  }
  const storedMask = deflateSync(mask, { level: 9 });
  const storedUpdates = deflateSync(updates.subarray(0, updateCount * 5), { level: 9 });
  const header = Buffer.alloc(32);
  header.write('C5T1SH01', 0, 'ascii');
  header.writeUInt32LE(layout.slotCount, 8);
  header.writeUInt32LE(instanceCount, 12);
  header.writeUInt16LE(segments.length, 16);
  header.writeUInt8(45, 18);
  header.writeUInt8(5, 19);
  header.writeUInt32LE(SH_MEAN_BYTES + SH_CODEBOOK_BYTES, 20);
  header.writeUInt32LE(storedMask.length, 24);
  header.writeUInt32LE(storedUpdates.length, 28);
  return {
    bytes: Buffer.concat([
      header,
      payload.subarray(SH_HEADER_BYTES, labelOffset),
      storedMask,
      storedUpdates,
    ]),
    updateCount,
    instanceCount,
  };
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const sourceCoReShContainer = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16.4cgs');
  const outputPath = resolve(process.argv[4] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_prs_morton.4cgs');
  const profile = process.argv[5] ?? 'prs';
  if (!['prs', 'braindance', 'braindance60', 'mesongs'].includes(profile)) throw new Error(`Unsupported 4CGS profile ${profile}.`);
  const target60Profile = profile === 'braindance60';
  const mesongsProfile = profile === 'mesongs';
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
    console.log(JSON.stringify({ phase: 'load', name: entry.name }));
  }
  // #WDD-gpt 2026-08-15 - 六段边界的 Position FP16 码精确对应；SH/DC 只为重复坐标消歧，避免把连续点误建成新 Track。
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const crop = robustCenter(segments[0]);
  const halfExtent = 2.5;
  const layout = buildCroppedMortonLayout(segments, permanent, crop.center, halfExtent);
  const positionBanks = segments.map((segment) => bankCount(segment, 'xyz_bank'));
  const rotationBanks = segments.map((segment) => bankCount(segment, 'rot_bank'));
  const scaleBanks = segments.map((segment) => bankCount(segment, 'scale_bank'));
  console.log(JSON.stringify({
    phase: 'layout',
    sourcePermanentTrackCount: permanent.trackCount,
    keptTrackCount: layout.trackCount,
    droppedTrackCount: layout.droppedTrackCount,
    center: crop.center,
    halfExtent,
  }));

  const positionStep = target60Profile ? 0.001 : 0.00075;
  const position = encodePositions(segments, layout, positionBanks, {
    center: crop.center,
    halfExtent,
    step: positionStep,
    maximumError: 0.005,
    cellSize: 0.5,
  });
  console.log(JSON.stringify({ phase: 'position', ...position.metrics }));
  const rotationBits = target60Profile ? 11 : 12;
  const maximumRotationAngle = target60Profile ? 0.2 : 0.1;
  const rotation = encodeRotations(segments, layout, rotationBanks, { bits: rotationBits, maximumAngleDegrees: maximumRotationAngle });
  console.log(JSON.stringify({ phase: 'rotation', ...rotation.metrics }));
  const so3Rotation = encodeSo3Rotations(segments, layout, rotationBanks, {
    bits: rotationBits, stepDegrees: target60Profile ? 0.05 : 0.025, maximumAngleDegrees: maximumRotationAngle,
  });
  const useSo3Rotation = so3Rotation.encoded.length < rotation.encoded.length;
  console.log(JSON.stringify({ phase: 'rotation-so3-selection', useSo3Rotation, ...so3Rotation.metrics }));
  const scale = encodeScales(segments, layout, scaleBanks, { step: 0.004, maximumLogError: 0.005 });
  console.log(JSON.stringify({ phase: 'scale', ...scale.metrics }));
  // #WDD-gpt 2026-08-15 - Scale 同时比较 rANS 近无损与 FP16 位级无损候选，始终选择实际字节更小者。
  const losslessScaleCandidates = ['0', '1', '2'].map((component) => {
    const names = segments.map((segment) => Array.from(
      { length: bankCount(segment, 'scale_bank') },
      (_, bank) => `scale_bank_${bank}_${component}`,
    ));
    const raw = temporalComponent(segments, layout, names);
    return { component, raw, storedBytes: deflateSync(raw, { level: 9 }).length };
  });
  const losslessScaleBytes = losslessScaleCandidates.reduce((sum, candidate) => sum + candidate.storedBytes, 0);
  const temporalAttributeScale = encodeTemporalAttribute(segments, layout, {
    prefix: 'scale_bank', components: ['0', '1', '2'], bankCounts: scaleBanks, exactHalf: true,
  });
  const dcBanks = segments.map((segment) => bankCount(segment, 'f_dc_bank'));
  const temporalAttributeDc = encodeTemporalAttribute(segments, layout, {
    prefix: 'f_dc_bank', components: ['0', '1', '2'], bankCounts: dcBanks, step: 2 ** -9,
  });
  console.log(JSON.stringify({ phase: 'temporal-attribute-scale', ...temporalAttributeScale.metrics }));
  console.log(JSON.stringify({ phase: 'temporal-attribute-dc', ...temporalAttributeDc.metrics }));
  let mixRqScale = null;
  let mixRqDc = null;
  let mixRqOpacity = null;
  let temporalRqScale = null;
  let temporalRqDc = null;
  let temporalRqOpacity = null;
  if (profile === 'braindance') {
    const scaleVectors = trackVectors(segments, layout, 'scale_bank', ['0', '1', '2']);
    mixRqScale = encodeScalarRq(scaleVectors.bits, scaleVectors.observationCount, scaleVectors.dimensions, {
      bitsByDimension: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
      predictors: [-1, -1, -1, 0, 1, 2, 0, 1, 2, 0, 1, 2],
      transform: 'identity',
      maximumError: 0.005,
      sampleCount: 32768,
    });
    console.log(JSON.stringify({ phase: 'mint-scalar-scale', ...mixRqScale.metrics }));
    const dcVectors = trackVectors(segments, layout, 'f_dc_bank', ['0', '1', '2']);
    mixRqDc = encodeScalarRq(dcVectors.bits, dcVectors.observationCount, dcVectors.dimensions, {
      bitsByDimension: [8, 8, 8, 12, 12, 12],
      predictors: [-1, -1, -1, 0, 1, 2],
      transform: 'identity',
      maximumError: 0.004,
      sampleCount: 32768,
    });
    console.log(JSON.stringify({ phase: 'mint-scalar-dc', ...mixRqDc.metrics }));
    const opacityVectors = trackVectors(segments, layout, 'opacity_bank', ['']);
    mixRqOpacity = encodeScalarRq(opacityVectors.bits, opacityVectors.observationCount, opacityVectors.dimensions, {
      bitsByDimension: [8, 12, 12, 12],
      predictors: [-1, 0, 0, 0],
      transform: 'opacityAlpha',
      maximumError: 0.003,
      sampleCount: 32768,
    });
    console.log(JSON.stringify({ phase: 'mint-scalar-opacity', ...mixRqOpacity.metrics }));
  } else if (target60Profile) {
    const scaleVectors = trackVectors(segments, layout, 'scale_bank', ['0', '1', '2']);
    mixRqScale = encodeWindowedMixRq(scaleVectors, layout.activeSlots, {
      levels: 5,
      transform: 'identity',
      trajectoryComponents: 3,
      maximumError: 0.05,
      sampleCount: 16384,
    });
    console.log(JSON.stringify({ phase: 'mint-mixrq60-scale', ...mixRqScale.metrics }));
    const dcVectors = trackVectors(segments, layout, 'f_dc_bank', ['0', '1', '2']);
    mixRqDc = encodeWindowedMixRq(dcVectors, layout.activeSlots, {
      levels: 3,
      transform: 'identity',
      trajectoryComponents: 3,
      maximumError: 0.02,
      sampleCount: 16384,
    });
    console.log(JSON.stringify({ phase: 'mint-mixrq60-dc', ...mixRqDc.metrics }));
    const opacityVectors = trackVectors(segments, layout, 'opacity_bank', ['']);
    mixRqOpacity = encodeWindowedMixRq(opacityVectors, layout.activeSlots, {
      levels: 2,
      transform: 'opacityAlpha',
      trajectoryComponents: 1,
      maximumError: 0.015,
      sampleCount: 16384,
    });
    console.log(JSON.stringify({ phase: 'mint-mixrq60-opacity', ...mixRqOpacity.metrics }));
  } else if (mesongsProfile) {
    // #WDD-gpt 2026-08-15 - MesonGS++ 迁移档对每个属性实测多组位宽，按真实容器字节选择而非用理论 bit 数拍板。
    const chooseTemporal = (name, vectors, bankCounts, components, maximumError, domain, candidates) => {
      const results = candidates.map((bitsByDimension) => encodeTemporalRq(
        vectors.bits,
        layout.activeSlots,
        bankCounts[0],
        components,
        {
          domain,
          maximumError,
          residualMaximumError: 1e6,
          bitsByDimension,
          sampleCount: 32768,
        },
      ));
      for (const result of results) console.log(JSON.stringify({ phase: `mesongs-${name}-candidate`, ...result.metrics }));
      return results.reduce((best, result) => result.encoded.length < best.encoded.length ? result : best);
    };
    const scaleVectors = trackVectors(segments, layout, 'scale_bank', ['0', '1', '2']);
    temporalRqScale = chooseTemporal('scale', scaleVectors, scaleVectors.bankCounts, 3, 0.005, 'identity', [
      [9, 9, 9, 7, 7, 7, 7, 7, 7, 9, 9, 9],
      [10, 10, 10, 8, 8, 8, 8, 8, 8, 10, 10, 10],
    ]);
    const dcVectors = trackVectors(segments, layout, 'f_dc_bank', ['0', '1', '2']);
    temporalRqDc = chooseTemporal('dc', dcVectors, dcVectors.bankCounts, 3, 0.004, 'identity', [
      [8, 8, 8, 9, 9, 9],
      [9, 9, 9, 10, 10, 10],
    ]);
    mixRqDc = encodeScalarRq(dcVectors.bits, dcVectors.observationCount, dcVectors.dimensions, {
      bitsByDimension: [8, 8, 8, 12, 12, 12],
      predictors: [-1, -1, -1, 0, 1, 2],
      transform: 'identity',
      maximumError: 0.004,
      sampleCount: 32768,
    });
    if (mixRqDc.encoded.length < temporalRqDc.encoded.length) temporalRqDc = mixRqDc;
    const opacityVectors = trackVectors(segments, layout, 'opacity_bank', ['']);
    temporalRqOpacity = chooseTemporal('opacity', opacityVectors, opacityVectors.bankCounts, 1, 0.003, 'opacityAlpha', [
      [7, 6, 6, 8],
      [8, 7, 7, 9],
    ]);
    mixRqOpacity = encodeScalarRq(opacityVectors.bits, opacityVectors.observationCount, opacityVectors.dimensions, {
      bitsByDimension: [8, 12, 12, 12],
      predictors: [-1, 0, 0, 0],
      transform: 'opacityAlpha',
      maximumError: 0.003,
      sampleCount: 32768,
    });
    if (mixRqOpacity.encoded.length < temporalRqOpacity.encoded.length) temporalRqOpacity = mixRqOpacity;
  }
  const scaleCandidateBytes = Math.min(losslessScaleBytes, scale.encoded.length, temporalAttributeScale.encoded.length);
  const useTemporalRqScale = temporalRqScale !== null && temporalRqScale.encoded.length < scaleCandidateBytes;
  const useMixRqScale = !useTemporalRqScale && mixRqScale !== null && mixRqScale.encoded.length < scaleCandidateBytes;
  const useTemporalAttributeScale = !useTemporalRqScale && !useMixRqScale && temporalAttributeScale.encoded.length < Math.min(losslessScaleBytes, scale.encoded.length);
  const useLosslessScale = !useTemporalRqScale && !useMixRqScale && !useTemporalAttributeScale && losslessScaleBytes < scale.encoded.length;
  console.log(JSON.stringify({
    phase: 'scale-selection',
    useTemporalRqScale,
    useMixRqScale,
    useTemporalAttributeScale,
    useLosslessScale,
    temporalRqBytes: temporalRqScale?.encoded.length,
    mixRqBytes: mixRqScale?.encoded.length,
    losslessScaleBytes,
    quantizedRansBytes: scale.encoded.length,
    temporalAttributeBytes: temporalAttributeScale.encoded.length,
  }));

  const streams = [];
  addStream(streams, 'active_masks', Buffer.from(activeMask(layout)));
  addStream(streams, 'prs_position', position.encoded, 'raw');
  addStream(streams, useSo3Rotation ? 'so3_rotation' : 'prs_rotation', useSo3Rotation ? so3Rotation.encoded : rotation.encoded, 'raw');
  if (useTemporalRqScale) {
    addStream(streams, 'tmrq_scale', temporalRqScale.encoded, 'raw');
  } else if (useMixRqScale) {
    addStream(streams, target60Profile ? 'mixrq_scale' : 'mixsc_scale', mixRqScale.encoded, 'raw');
  } else if (useTemporalAttributeScale) {
    addStream(streams, 'tattr_scale', temporalAttributeScale.encoded, 'raw');
  } else if (useLosslessScale) {
    for (const candidate of losslessScaleCandidates) addStream(streams, `scale_bank:${candidate.component}`, candidate.raw);
  } else {
    addStream(streams, 'prs_scale', scale.encoded, 'raw');
  }
  const selectedRqDc = temporalRqDc?.encoded.length < temporalAttributeDc.encoded.length ? temporalRqDc : null;
  const selectedMixDc = mixRqDc?.encoded.length < temporalAttributeDc.encoded.length ? mixRqDc : null;
  if (selectedRqDc) {
    addStream(streams, 'tmrq_dc', temporalRqDc.encoded, 'raw');
  } else if (selectedMixDc) {
    addStream(streams, target60Profile ? 'mixrq_dc' : 'mixsc_dc', mixRqDc.encoded, 'raw');
  } else {
    addStream(streams, 'tattr_dc', temporalAttributeDc.encoded, 'raw');
  }
  if (temporalRqOpacity && temporalRqOpacity.encoded.length < 10_081_565) {
    addStream(streams, 'tmrq_opacity', temporalRqOpacity.encoded, 'raw');
  } else if (mixRqOpacity && mixRqOpacity.encoded.length < 10_081_565) {
    addStream(streams, target60Profile ? 'mixrq_opacity' : 'mixsc_opacity', mixRqOpacity.encoded, 'raw');
  } else {
    addTrackStreams(streams, segments, layout, 'opacity_bank', ['']);
  }
  addStream(streams, 'lifetime_mu', temporalComponent(segments, layout, segments.map(() => ['lifetime_mu'])));
  addStream(streams, 'lifetime_w', temporalComponent(segments, layout, segments.map(() => ['lifetime_w'])));
  const { payload: sourceCoReSh } = extractRawStream(await readFile(sourceCoReShContainer), 'coresh5r');
  const sharedSh = exactSharedShStream(sourceCoReSh, segments, layout);
  addStream(streams, 'coresh5r_shared', sharedSh.bytes, 'raw');

  const firstFrame = Number(entries[0].match[1]);
  const lastFrame = Number(entries.at(-1).match[2]);
  const manifest = {
    format: '4CGS',
    version: 2,
    codecName: mesongsProfile
      ? 'CoRe4D-MesonGSPlusPlusAdapted-MortonPermanentTrack-MixedBit-TemporalResidual-CoReSH5R'
      : (profile !== 'prs'
        ? 'CoRe4D-MINT-MixRQ-MortonPermanentTrack-BoundedExceptions-CoReSH5R'
        : 'CoRe4D-MortonPermanentTrack-HierMotion-ReversibleDelta-3DResidual-rANS-CoReSH5R'),
    sourceDirectory,
    sourceBytes,
    slotCount: layout.slotCount,
    sourcePermanentTrackCount: permanent.trackCount,
    firstFrame,
    lastFrame,
    uniqueFrameCount: lastFrame - firstFrame + 1,
    trackIdPolicy: 'monotonic permanent Track ID; never recycled; reliable boundary match inherits ID',
    trackOrder: 'Morton code of first observed position inside crop cube; Track ID equals sorted index',
    crop: {
      units: 'm',
      centerPolicy: 'first-frame 0.5%-99.5% robust AABB midpoint',
      robustBounds: crop.bounds,
      center: crop.center,
      extent: [5, 5, 5],
      halfExtent,
      rule: 'retain a permanent track only when every stored position keyframe is inside the closed cube',
      sourcePermanentTrackCount: permanent.trackCount,
      retainedPermanentTrackCount: layout.trackCount,
      droppedPermanentTrackCount: layout.droppedTrackCount,
    },
    prs: {
      position: {
        center: crop.center,
        halfExtent,
        step: positionStep,
        maximumEuclideanError: 0.005,
        cellSize: 0.5,
        exceptionPolicy: 'source FP16 xyz repair when reconstructed 3D error exceeds the hard bound',
      },
      rotation: {
        bits: rotationBits,
        mode: useSo3Rotation ? 'smallest-three-birth-so3-temporal-residual-rans' : 'smallest-three-component-delta-rans',
        stepDegrees: useSo3Rotation ? so3Rotation.metrics.stepDegrees : undefined,
        maximumAngleDegrees: maximumRotationAngle,
        exceptionPolicy: 'source FP16 quaternion repair when angular error exceeds the hard bound',
      },
      scale: {
        mode: useTemporalRqScale
          ? 'mesongs-temporal-rq-bounded'
          : (useMixRqScale
          ? (target60Profile ? 'mint-mixrq60-bounded' : 'mint-scalar-rq-bounded')
          : (useTemporalAttributeScale ? 'exact-fp16-temporal-residual-rans'
            : (useLosslessScale ? 'lossless-fp16-temporal-xor-deflate' : 'quantized-rans'))),
        step: useLosslessScale || useTemporalAttributeScale ? 0 : 0.004,
        maximumLogError: useLosslessScale || useTemporalAttributeScale ? 0 : (useTemporalRqScale ? temporalRqScale.metrics.maximumAllowedError : (useMixRqScale ? mixRqScale.metrics.maximumAllowedError : 0.005)),
        selectedBytes: useTemporalRqScale ? temporalRqScale.encoded.length : (useMixRqScale ? mixRqScale.encoded.length : (useTemporalAttributeScale ? temporalAttributeScale.encoded.length : (useLosslessScale ? losslessScaleBytes : scale.encoded.length))),
        rejectedQuantizedRansBytes: useTemporalRqScale || useMixRqScale || useTemporalAttributeScale || useLosslessScale ? scale.encoded.length : undefined,
        exceptionPolicy: useLosslessScale || useTemporalAttributeScale
          ? 'not needed; selected stream is bit exact'
          : (useTemporalRqScale || useMixRqScale
            ? 'source FP16 scale trajectory repair when any decoded log-scale component exceeds the hard bound'
            : 'source FP16 log-scale repair when component error exceeds the hard bound'),
      },
      positionMetrics: position.metrics,
      rotationMetrics: rotation.metrics,
      so3RotationMetrics: so3Rotation.metrics,
      scaleCandidateMetrics: scale.metrics,
    },
    temporalAttributes: {
      scale: temporalAttributeScale.metrics,
      colorDc: temporalAttributeDc.metrics,
      selected: {
        scale: streams.some((stream) => stream.name === 'tattr_scale'),
        colorDc: streams.some((stream) => stream.name === 'tattr_dc'),
      },
    },
    nonPrsPolicy: profile !== 'prs'
      ? 'per-window mixed residual-quantization labels and FP16 centroids with bounded source-bit exception repair; lifetime remains lossless'
      : 'lossless source FP16 bits with permanent-track temporal XOR and deflate',
    mintMixRq: !mesongsProfile && profile !== 'prs' ? {
      source: 'public MINT v6 runtime structure; not an official binary-compatible MINT encoder',
      targetProfile: target60Profile ? 'under-60M search candidate' : 'strict bounded scalar profile',
      scale: mixRqScale?.metrics,
      colorDc: mixRqDc?.metrics,
      opacity: mixRqOpacity?.metrics,
      selected: {
        scale: useMixRqScale,
        colorDc: streams.some((stream) => ['mixsc_dc', 'mixrq_dc'].includes(stream.name)),
        opacity: streams.some((stream) => ['mixsc_opacity', 'mixrq_opacity'].includes(stream.name)),
      },
    } : undefined,
    mesongsTemporal: mesongsProfile ? {
      source: 'MesonGS++ transfer: Morton order, target-size candidate selection, attribute-group mixed precision, bounded repair and entropy coding; temporal prediction is a 4DGS extension',
      pruning: false,
      boundaryPolicy: 'matched track first key references previous segment final key; source Position is exact at all five boundaries; Scale and DC are over 99.99% exact',
      scale: temporalRqScale?.metrics,
      colorDc: temporalRqDc?.metrics,
      opacity: temporalRqOpacity?.metrics,
      selected: {
        scale: streams.some((stream) => stream.name === 'tmrq_scale'),
        colorDc: streams.some((stream) => stream.name === 'tmrq_dc'),
        opacity: streams.some((stream) => stream.name === 'tmrq_opacity'),
      },
    } : undefined,
    shPolicy: 'one shared ordinary CoReSH-5R codebook; exact trajectory labels on permanent Track IDs',
    segments: entries.map((entry, index) => ({
      name: entry.name.replace(/\.(?:raw4d|ply4)$/i, ''),
      firstFrame: Number(entry.match[1]),
      lastFrame: Number(entry.match[2]),
      sourceGaussianCount: segments[index].count,
      gaussianCount: layout.activeSlots[index].length,
      totalFrames: Number(entry.match[2]) - Number(entry.match[1]) + 1,
      bankCounts: {
        position: positionBanks[index],
        rotation: rotationBanks[index],
        colorDc: bankCount(segments[index], 'f_dc_bank'),
        scale: scaleBanks[index],
        opacity: bankCount(segments[index], 'opacity_bank'),
      },
      // #WDD-gpt 2026-08-16 - 4CGS 清单保留源 PLY4 的真实 stride，避免解码时从 bank 数量反推歧义时间轴。
      keyframeStrides: sourceKeyframeStrides(segments[index]),
    })),
    matches: layout.matches.map((match) => ({
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
  const outputBytes = container.length;
  const report = {
    outputPath,
    outputBytes,
    outputM: outputBytes / 1_000_000,
    sourceBytes,
    sourceM: sourceBytes / 1_000_000,
    compressionRatio: sourceBytes / outputBytes,
    target15xBytes: Math.floor(sourceBytes / 15),
    target15xM: sourceBytes / 15 / 1_000_000,
    meets15x: sourceBytes / outputBytes >= 15,
    slotCount: layout.slotCount,
    uniqueFrameCount: manifest.uniqueFrameCount,
    crop: manifest.crop,
    prs: manifest.prs,
    sharedSh: { bytes: sharedSh.bytes.length, updateCount: sharedSh.updateCount, instanceCount: sharedSh.instanceCount },
    streams: manifest.streams,
    containerSha256: sha256(container),
  };
  await writeFile(`${outputPath}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ phase: 'complete', ...report }));
}

// #WDD-gpt 2026-08-15 - 新 4CGS 正式编码链在 JS 中完成中心裁剪、永久轨迹、P/R/S 近无损压缩和共享 CoReSH-5R 封装。
// #WDD-gpt 2026-08-15 - 增加 Braindance 风格分属性 MixRQ 码表、熵编码标签和有界例外修复档，且不引入 Python 正式依赖。
await main();
