import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { brotliCompressSync, constants } from 'node:zlib';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, encodePositions, sha256 } from './fourcgs-prs-codec.mjs';
import { encodeOpacityHybrid, decodeOpacityHybrid } from './fourcgs-opacity-hybrid-codec.mjs';
import { encodeTemporalAttribute } from './fourcgs-temporal-attribute-codec.mjs';
import { encodeSo3Rotations } from './fourcgs-so3-temporal-codec.mjs';
import { decodeV21StructuredStream, encodeV21StructuredStream, encodeV22StructuredStream } from './fourcgs-v21-lossless-codec.mjs';

const MAGIC = '4CGSPRS2';
const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

function readContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported 4CGS source.');
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  const streams = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const payload = bytes.subarray(offset, offset + entry.storedBytes);
    if (payload.length !== entry.storedBytes || sha256(payload) !== entry.storedSha256) throw new Error(`Stored stream validation failed: ${entry.name}.`);
    streams.set(entry.name, payload);
    offset += entry.storedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unexpected trailing bytes: ${bytes.length - offset}.`);
  return { manifest, streams };
}

function packContainer(manifest, streams) {
  const directory = Buffer.from(JSON.stringify(manifest), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(directory.length, 8);
  return Buffer.concat([prefix, directory, ...manifest.streams.map((entry) => streams.get(entry.name))]);
}

function brotli(bytes) {
  return brotliCompressSync(bytes, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_LGWIN]: 24,
  } });
}

async function readSegments(directory) {
  const names = (await readdir(directory))
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  if (names.length !== 6) throw new Error(`Expected six RAW4D segments, found ${names.length}.`);
  const segments = [];
  for (const name of names) segments.push(await readSegment(join(directory, name)));
  return segments;
}

function opacityVectors(segments, layout) {
  const dimensions = bankCount(segments[0], 'opacity_bank');
  const observationCount = layout.activeSlots.reduce((sum, slots) => sum + slots.length, 0);
  const bits = new Uint16Array(observationCount * dimensions);
  let observation = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const properties = Array.from({ length: dimensions }, (_, bank) => segment.propertyIndex.get(`opacity_bank_${bank}`));
    for (const slot of layout.activeSlots[segmentIndex]) {
      const source = layout.slotToLocal[segmentIndex][slot] * segment.propertyNames.length;
      for (let dimension = 0; dimension < dimensions; dimension += 1) bits[observation * dimensions + dimension] = segment.rows[source + properties[dimension]];
      observation += 1;
    }
  }
  return { bits, observationCount, dimensions };
}

// #WDD-gpt 2026-08-16 - V2.5 固化与对象速度无关的误差上界；更快运动只增加残差码率，绝不自动放宽质量。
async function main() {
  const sourcePath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const sourceDirectory = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_5.4cgs');
  const opacityBaseMaximumAlphaError = Number(process.argv[5] ?? 0.003);
  const opacityBaseBits = Number(process.argv[6] ?? 8);
  const opacityBaseExact = (process.argv[7] ?? 'exact') === 'exact';
  const scaleStep = Number(process.argv[8] ?? 0.046875);
  const rotationStepDegrees = Number(process.argv[9] ?? 0.3);
  const positionStep = Number(process.argv[10] ?? 0.000625);
  const positionMaximumError = Number(process.argv[11] ?? 0.001);
  if (!(opacityBaseMaximumAlphaError > 0) || !Number.isInteger(opacityBaseBits)) throw new Error('Invalid V2.5 Opacity base policy.');
  if (![scaleStep, rotationStepDegrees, positionStep, positionMaximumError].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('V2.5 fixed error steps and bounds must be positive finite values.');
  }
  const started = performance.now();
  const sourceBytes = await readFile(sourcePath);
  const source = readContainer(sourceBytes);
  const segments = await readSegments(sourceDirectory);
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, source.manifest.crop.center, source.manifest.crop.halfExtent);
  if (layout.slotCount !== source.manifest.slotCount) throw new Error('V2.5 permanent Track layout mismatch.');

  process.stderr.write('V2.5 encode bounded Position, Rotation and Scale...\n');
  const position = encodePositions(segments, layout, segments.map((segment) => bankCount(segment, 'xyz_bank')), {
    center: source.manifest.crop.center,
    halfExtent: source.manifest.crop.halfExtent,
    step: positionStep,
    maximumError: positionMaximumError,
    cellSize: 0.5,
  });
  const positionStored = await encodeV21StructuredStream('prs_position', position.encoded, source.manifest);
  const restoredPosition = await decodeV21StructuredStream('prs_position', positionStored.encoded, source.manifest);
  if (!restoredPosition.equals(position.encoded)) throw new Error('V2.5 Position structured round-trip failed.');
  const rotationMaximumAngleDegrees = rotationStepDegrees;
  const rotation = encodeSo3Rotations(segments, layout, segments.map((segment) => bankCount(segment, 'rot_bank')), {
    bits: 12, stepDegrees: rotationStepDegrees, maximumAngleDegrees: rotationMaximumAngleDegrees,
  });
  const rotationStored = await encodeV22StructuredStream('so3_rotation', rotation.encoded);
  const restoredRotation = await decodeV21StructuredStream('so3_rotation', rotationStored.encoded, source.manifest);
  if (!restoredRotation.equals(rotation.encoded)) throw new Error('V2.5 Rotation structured round-trip failed.');
  const scale = encodeTemporalAttribute(segments, layout, {
    prefix: 'scale_bank', components: ['0', '1', '2'],
    bankCounts: segments.map((segment) => bankCount(segment, 'scale_bank')),
    exactHalf: false, step: scaleStep,
  });
  const scaleStored = await encodeV22StructuredStream('tattr_scale', scale.encoded);
  const restoredScale = await decodeV21StructuredStream('tattr_scale', scaleStored.encoded, source.manifest);
  if (!restoredScale.equals(scale.encoded)) throw new Error('V2.5 Scale structured round-trip failed.');

  process.stderr.write('V2.5 encode exact temporal Opacity banks...\n');
  const opacity = opacityVectors(segments, layout);
  const opacityHybrid = encodeOpacityHybrid(opacity.bits, opacity.observationCount, {
    baseBits: opacityBaseBits, baseMaximumAlphaError: opacityBaseMaximumAlphaError, baseExact: opacityBaseExact,
    sampleCount: 32768, residualCompression: 'none',
  });
  const restoredOpacity = decodeOpacityHybrid(opacityHybrid.encoded);
  for (let observation = 0; observation < opacity.observationCount; observation += 1) {
    for (let dimension = opacityBaseExact ? 0 : 1; dimension < 4; dimension += 1) {
      const index = observation * 4 + dimension;
      if (restoredOpacity.bits[index] !== opacity.bits[index]) throw new Error(`V2.5 exact Opacity mismatch at ${index}.`);
    }
  }

  const opacityStored = brotli(opacityHybrid.encoded);
  const replacements = new Map([
    ['prs_position', { raw: positionStored.encoded, stored: positionStored.encoded, compression: 'raw', innerBytes: position.encoded.length, innerSha256: sha256(position.encoded) }],
    ['so3_rotation', { raw: rotationStored.encoded, stored: rotationStored.encoded, compression: 'raw', innerBytes: rotation.encoded.length, innerSha256: sha256(rotation.encoded) }],
    ['tattr_scale', { raw: scaleStored.encoded, stored: scaleStored.encoded, compression: 'raw', innerBytes: scale.encoded.length, innerSha256: sha256(scale.encoded) }],
    ['mixsc_opacity', { raw: opacityHybrid.encoded, stored: opacityStored, compression: 'brotli' }],
  ]);
  const outputStreams = new Map(source.streams);
  for (const [name, replacement] of replacements) outputStreams.set(name, replacement.stored);
  const maximumScaleRelativeError = Math.expm1(scale.metrics.measuredMaximumError);
  const nextManifest = {
    ...source.manifest,
    codecName: `${source.manifest.codecName}-V25ExactTemporalOpacityGuard`,
    prs: {
      ...source.manifest.prs,
      position: {
        ...source.manifest.prs.position,
        step: positionStep,
        maximumEuclideanError: position.metrics.measuredMaximumEuclideanError,
        measuredRmse: position.metrics.measuredRmse,
        measuredMaximumEuclideanError: position.metrics.measuredMaximumEuclideanError,
      },
      rotation: {
        ...source.manifest.prs.rotation,
        stepDegrees: rotationStepDegrees,
        maximumAngleDegrees: rotationMaximumAngleDegrees,
        measuredAngularRmseDegrees: rotation.metrics.measuredAngularRmseDegrees,
        measuredMaximumAngleDegrees: rotation.metrics.measuredMaximumAngleDegrees,
      },
      scale: {
        ...source.manifest.prs.scale,
        mode: 'v25-bounded-temporal-linear-residual-quantized-predictive-rice64',
        step: scaleStep,
        maximumLogError: scale.metrics.measuredMaximumError,
        maximumRelativeRadiusError: maximumScaleRelativeError,
        selectedBytes: scaleStored.encoded.length,
        exceptionPolicy: 'uniform log-scale quantization with fixed bound; every source key is retained',
      },
      scaleCandidateMetrics: scale.metrics,
    },
    temporalAttributes: { ...source.manifest.temporalAttributes, scale: scale.metrics },
    mintMixRq: {
      ...source.manifest.mintMixRq,
      opacity: {
        ...opacityHybrid.metrics,
        maximumAllowedAlphaError: opacityBaseExact ? 0 : opacityBaseMaximumAlphaError,
        measuredMaximumAlphaError: opacityHybrid.metrics.base.measuredMaximumError,
        measuredAlphaRmse: opacityHybrid.metrics.base.measuredRmse,
      },
    },
    compressionV23: source.manifest.compressionV23 ? {
      ...source.manifest.compressionV23,
      bounds: {
        ...source.manifest.compressionV23.bounds,
        positionMeters: position.metrics.measuredMaximumEuclideanError,
        rotationDegrees: rotation.metrics.measuredMaximumAngleDegrees,
        scaleLog: scale.metrics.measuredMaximumError,
        scaleRelativeRadius: maximumScaleRelativeError,
        opacityAlpha: opacityHybrid.metrics.base.measuredMaximumError,
      },
    } : undefined,
    compressionV25: {
      version: '2.5', parentContainer: sourcePath, parentSha256: sha256(sourceBytes), targetBytes: 60_000_000,
      pruning: false, changedStreams: ['prs_position', 'so3_rotation', 'tattr_scale', 'mixsc_opacity'],
      generalizationPolicy: 'fixed attribute error bounds; no motion-speed or scene-specific threshold tuning',
      positionPolicy: {
        step: positionStep,
        maximumAllowedEuclideanErrorMeters: positionMaximumError,
        measuredRmseMeters: position.metrics.measuredRmse,
        measuredMaximumEuclideanErrorMeters: position.metrics.measuredMaximumEuclideanError,
      },
      opacityPolicy: {
        baseBank: {
          codec: opacityBaseExact ? 'exact-fp16-byte-plane' : `ScalarRQ-${opacityBaseBits}`,
          bitExactFp16: opacityBaseExact,
          maximumAllowedAlphaError: opacityBaseExact ? 0 : opacityBaseMaximumAlphaError,
          measuredMaximumAlphaError: opacityHybrid.metrics.base.measuredMaximumError,
        },
        temporalBanks: { indices: [1, 2, 3], codec: opacityHybrid.metrics.residualTransform, bitExactFp16: true },
      },
      rotationPolicy: {
        stepDegrees: rotationStepDegrees,
        maximumAllowedAngleDegrees: rotationMaximumAngleDegrees,
        measuredMaximumAngleDegrees: rotation.metrics.measuredMaximumAngleDegrees,
      },
      scalePolicy: { step: scaleStep, maximumLogError: scale.metrics.measuredMaximumError, maximumRelativeRadiusError: maximumScaleRelativeError },
      qualityGate: { segments: 6, uniqueTimelineFrames: 180, camerasPerFrame: 3, samples: 540, aggregateMinimumPsnr: 40, perViewMinimumPsnr: 37, status: 'pending' },
    },
    streams: source.manifest.streams.map((entry) => {
      const replacement = replacements.get(entry.name);
      if (!replacement) return entry;
      return {
        ...entry, compression: replacement.compression, rawBytes: replacement.raw.length, rawSha256: sha256(replacement.raw),
        storedBytes: replacement.stored.length, storedSha256: sha256(replacement.stored),
        ...(replacement.innerBytes ? {
          v21DecodedBytes: replacement.innerBytes, v21DecodedSha256: replacement.innerSha256,
          structuredDecodedBytes: replacement.innerBytes, structuredDecodedSha256: replacement.innerSha256,
        } : {}),
      };
    }),
  };
  const container = packContainer(nextManifest, outputStreams);
  const reopened = readContainer(container);
  for (const [name, replacement] of replacements) if (!reopened.streams.get(name).equals(replacement.stored)) throw new Error(`V2.5 reopen failed for ${name}.`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, container);
  const report = {
    version: 'Compression V2.5 exact temporal Opacity guard', sourcePath, sourceBytes: sourceBytes.length, sourceSha256: sha256(sourceBytes),
    outputPath, outputBytes: container.length, outputBytesM: container.length / 1_000_000, outputSha256: sha256(container),
    meets60M: container.length <= 60_000_000, ratioToSixRaw4d: source.manifest.sourceBytes / container.length,
    bounds: nextManifest.compressionV23?.bounds,
    changedStreams: [...replacements].map(([name, replacement]) => ({
      name, sourceBytes: source.manifest.streams.find((entry) => entry.name === name).storedBytes,
      outputBytes: replacement.stored.length,
      rawBytes: replacement.raw.length,
      compression: replacement.compression,
      deltaBytes: replacement.stored.length - source.manifest.streams.find((entry) => entry.name === name).storedBytes,
    })),
    opacity: opacityHybrid.metrics, position: position.metrics, rotation: rotation.metrics, scale: scale.metrics, qualityGate: nextManifest.compressionV25.qualityGate,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  await writeFile(`${outputPath}.repack.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
