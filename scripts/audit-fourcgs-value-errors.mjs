import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, halfToFloat, sha256 } from './fourcgs-prs-codec.mjs';

const MAGIC = '4CGSPRS2';
const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const SH_C0 = 0.28209479177387814;
const HISTOGRAM_MIN_LOG10 = -12;
const HISTOGRAM_MAX_LOG10 = 2;
const HISTOGRAM_BINS_PER_DECADE = 20;
const HISTOGRAM_BIN_COUNT = (HISTOGRAM_MAX_LOG10 - HISTOGRAM_MIN_LOG10) * HISTOGRAM_BINS_PER_DECADE;

const halfTable = new Float32Array(65536);
for (let bits = 0; bits < halfTable.length; bits += 1) halfTable[bits] = halfToFloat(bits);

function readContainerManifest(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported 4CGS container.');
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  let offset = 12 + manifestBytes;
  for (const stream of manifest.streams) {
    const payload = bytes.subarray(offset, offset + stream.storedBytes);
    if (payload.length !== stream.storedBytes || sha256(payload) !== stream.storedSha256) {
      throw new Error(`4CGS stream verification failed: ${stream.name}.`);
    }
    offset += stream.storedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unexpected trailing 4CGS bytes: ${bytes.length - offset}.`);
  return manifest;
}

async function readSourceSegments(directory) {
  const names = (await readdir(directory))
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  if (names.length === 0) throw new Error(`No segment_*.raw4d files found in ${directory}.`);
  const segments = [];
  for (const name of names) segments.push(await readSegment(join(directory, name)));
  return segments;
}

function decodedNameForSource(name) {
  return name.replace(/\.raw4d$/, '.decoded.raw4d');
}

function reconstructedProperty(name) {
  if (/^[xyz]$/.test(name)) return `xyz_bank_0_${name}`;
  const dc = /^f_dc_(\d+)$/.exec(name);
  if (dc) return `f_dc_bank_0_${dc[1]}`;
  if (name === 'opacity') return 'opacity_bank_0';
  const scale = /^scale_(\d+)$/.exec(name);
  if (scale) return `scale_bank_0_${scale[1]}`;
  if (/^n[xyz]$/.test(name)) return null;
  return name;
}

function attributeForProperty(name) {
  if (/^[xyz]$/.test(name) || name.startsWith('xyz_bank_')) return 'position';
  if (/^n[xyz]$/.test(name)) return 'normal';
  if (name.startsWith('f_rest_')) return 'sh';
  if (name.startsWith('f_dc_')) return 'dc';
  if (name === 'opacity' || name.startsWith('opacity_bank_')) return 'opacity';
  if (name.startsWith('scale_')) return 'scale';
  if (name.startsWith('rot_bank_')) return 'rotation';
  if (name.startsWith('lifetime_')) return 'lifetime';
  return 'other';
}

function makeStats(name, unit = 'native') {
  return {
    name,
    unit,
    count: 0,
    finiteCount: 0,
    nonFiniteCount: 0,
    bitExactCount: 0,
    numericExactCount: 0,
    finiteNumericExactCount: 0,
    negativeCount: 0,
    positiveCount: 0,
    sumSignedError: 0,
    sumAbsoluteError: 0,
    sumSquaredError: 0,
    minimumSignedError: Number.POSITIVE_INFINITY,
    maximumSignedError: Number.NEGATIVE_INFINITY,
    maximumAbsoluteError: 0,
    maximumLocation: null,
    histogram: new Float64Array(HISTOGRAM_BIN_COUNT + 2),
  };
}

function histogramIndex(absoluteError) {
  if (absoluteError === 0) return -1;
  const coordinate = Math.floor((Math.log10(absoluteError) - HISTOGRAM_MIN_LOG10) * HISTOGRAM_BINS_PER_DECADE);
  if (coordinate < 0) return 0;
  if (coordinate >= HISTOGRAM_BIN_COUNT) return HISTOGRAM_BIN_COUNT + 1;
  return coordinate + 1;
}

function record(stats, sourceValue, decodedValue, bitExact, location) {
  stats.count += 1;
  if (bitExact) stats.bitExactCount += 1;
  if (!Number.isFinite(sourceValue) || !Number.isFinite(decodedValue)) {
    stats.nonFiniteCount += 1;
    if (Object.is(sourceValue, decodedValue)) stats.numericExactCount += 1;
    return;
  }
  stats.finiteCount += 1;
  const signedError = decodedValue - sourceValue;
  const absoluteError = Math.abs(signedError);
  if (absoluteError === 0) {
    stats.numericExactCount += 1;
    stats.finiteNumericExactCount += 1;
  }
  else if (signedError < 0) stats.negativeCount += 1;
  else stats.positiveCount += 1;
  stats.sumSignedError += signedError;
  stats.sumAbsoluteError += absoluteError;
  stats.sumSquaredError += signedError * signedError;
  stats.minimumSignedError = Math.min(stats.minimumSignedError, signedError);
  stats.maximumSignedError = Math.max(stats.maximumSignedError, signedError);
  if (absoluteError > stats.maximumAbsoluteError) {
    stats.maximumAbsoluteError = absoluteError;
    stats.maximumLocation = { ...location, sourceValue, decodedValue, signedError, absoluteError };
  }
  const index = histogramIndex(absoluteError);
  if (index >= 0) stats.histogram[index] += 1;
}

function histogramRange(index) {
  if (index === 0) return { lower: 0, upper: 10 ** HISTOGRAM_MIN_LOG10 };
  if (index === HISTOGRAM_BIN_COUNT + 1) return { lower: 10 ** HISTOGRAM_MAX_LOG10, upper: null };
  return {
    lower: 10 ** (HISTOGRAM_MIN_LOG10 + (index - 1) / HISTOGRAM_BINS_PER_DECADE),
    upper: 10 ** (HISTOGRAM_MIN_LOG10 + index / HISTOGRAM_BINS_PER_DECADE),
  };
}

function approximateQuantile(stats, probability) {
  if (stats.finiteCount === 0) return null;
  const target = Math.max(1, Math.ceil(stats.finiteCount * probability));
  if (target <= stats.finiteNumericExactCount) return 0;
  let cumulative = stats.finiteNumericExactCount;
  for (let index = 0; index < stats.histogram.length; index += 1) {
    cumulative += stats.histogram[index];
    if (cumulative >= target) return histogramRange(index).upper ?? stats.maximumAbsoluteError;
  }
  return stats.maximumAbsoluteError;
}

function finishStats(stats) {
  const finite = stats.finiteCount;
  const histogram = [];
  if (stats.finiteNumericExactCount > 0) histogram.push({ label: '0', lower: 0, upper: 0, count: stats.finiteNumericExactCount });
  for (let index = 0; index < stats.histogram.length; index += 1) {
    const count = stats.histogram[index];
    if (count === 0) continue;
    histogram.push({ label: index === 0 ? `<1e${HISTOGRAM_MIN_LOG10}` : index === HISTOGRAM_BIN_COUNT + 1 ? `>=1e${HISTOGRAM_MAX_LOG10}` : null, ...histogramRange(index), count });
  }
  return {
    name: stats.name,
    unit: stats.unit,
    count: stats.count,
    finiteCount: finite,
    nonFiniteCount: stats.nonFiniteCount,
    bitExactCount: stats.bitExactCount,
    bitExactRate: stats.count > 0 ? stats.bitExactCount / stats.count : null,
    numericExactCount: stats.numericExactCount,
    numericExactRate: stats.count > 0 ? stats.numericExactCount / stats.count : null,
    finiteNumericExactCount: stats.finiteNumericExactCount,
    negativeCount: stats.negativeCount,
    zeroCount: stats.finiteNumericExactCount,
    positiveCount: stats.positiveCount,
    meanSignedError: finite > 0 ? stats.sumSignedError / finite : null,
    meanAbsoluteError: finite > 0 ? stats.sumAbsoluteError / finite : null,
    rmse: finite > 0 ? Math.sqrt(stats.sumSquaredError / finite) : null,
    minimumSignedError: finite > 0 ? stats.minimumSignedError : null,
    maximumSignedError: finite > 0 ? stats.maximumSignedError : null,
    maximumAbsoluteError: finite > 0 ? stats.maximumAbsoluteError : null,
    maximumLocation: stats.maximumLocation,
    absoluteErrorQuantileUpperBounds: {
      p50: approximateQuantile(stats, 0.5),
      p90: approximateQuantile(stats, 0.9),
      p95: approximateQuantile(stats, 0.95),
      p99: approximateQuantile(stats, 0.99),
      p999: approximateQuantile(stats, 0.999),
      p100: stats.maximumAbsoluteError,
    },
    histogram,
  };
}

function normalizedQuaternion(values) {
  const length = Math.hypot(...values);
  return length > 0 && Number.isFinite(length) ? values.map((value) => value / length) : [1, 0, 0, 0];
}

function quaternionAngleDegrees(source, decoded) {
  const a = normalizedQuaternion(source);
  const b = normalizedQuaternion(decoded);
  const dot = Math.min(1, Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

function scalarValue(rows, base, property) {
  return halfTable[rows[base + property]];
}

function recordSemanticVectors(source, decoded, sourceBase, decodedBase, sourceIndex, decodedIndex, segmentName, row, slot, semanticStats, semanticCounts) {
  for (let bank = -1; bank < 11; bank += 1) {
    const sourceNames = bank < 0 ? ['x', 'y', 'z'] : ['x', 'y', 'z'].map((component) => `xyz_bank_${bank}_${component}`);
    if (!sourceNames.every((name) => sourceIndex.has(name))) continue;
    const decodedNames = bank < 0 ? ['x', 'y', 'z'].map((component) => `xyz_bank_0_${component}`) : sourceNames;
    const a = sourceNames.map((name) => scalarValue(source.rows, sourceBase, sourceIndex.get(name)));
    const b = decodedNames.map((name) => scalarValue(decoded.rows, decodedBase, decodedIndex.get(name)));
    record(semanticStats.positionEuclidean, 0, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), false,
      { segment: segmentName, sourceRow: row, permanentTrack: slot, bank: bank < 0 ? 'base' : bank });
  }
  for (let bank = 0; bank < 16; bank += 1) {
    const names = ['w', 'x', 'y', 'z'].map((component) => `rot_bank_${bank}_${component}`);
    if (!names.every((name) => sourceIndex.has(name) && decodedIndex.has(name))) break;
    const a = names.map((name) => scalarValue(source.rows, sourceBase, sourceIndex.get(name)));
    const b = names.map((name) => scalarValue(decoded.rows, decodedBase, decodedIndex.get(name)));
    record(semanticStats.rotationAngle, 0, quaternionAngleDegrees(a, b), false,
      { segment: segmentName, sourceRow: row, permanentTrack: slot, bank });
    const normalizedA = normalizedQuaternion(a);
    const normalizedB = normalizedQuaternion(b);
    const rawDot = normalizedA.reduce((sum, value, index) => sum + value * normalizedB[index], 0);
    const sign = rawDot < 0 ? -1 : 1;
    if (sign < 0) semanticCounts.rotationSignFlipQuaternions += 1;
    for (let component = 0; component < 4; component += 1) {
      record(semanticStats.rotationComponentSignAligned, normalizedA[component], normalizedB[component] * sign, false,
        { segment: segmentName, sourceRow: row, permanentTrack: slot, bank, component: names[component] });
    }
  }
}

function aliasMode(sourceName, decodedName) {
  if (decodedName === null) return 'implicit-zero';
  if (decodedName === sourceName) return 'physical';
  return 'alias';
}

// #WDD-gpt 2026-08-16 - 对六段 RAW4D 的每个 FP16 数值逐一验收，并输出可复核的属性级误差分布。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const decodedDirectory = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/v26_final_decoded');
  const containerPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_6.4cgs');
  const outputPath = resolve(process.argv[5] ?? 'artifacts/compression_v2_20260816/V26_VALUE_ERROR_AUDIT.json');
  const started = performance.now();
  const [sourceSegments, containerBytes] = await Promise.all([readSourceSegments(sourceDirectory), readFile(containerPath)]);
  const manifest = readContainerManifest(containerBytes);
  const decodedSegments = [];
  for (const source of sourceSegments) decodedSegments.push(await readSegment(join(decodedDirectory, decodedNameForSource(basename(source.path)))));
  if (decodedSegments.length !== sourceSegments.length) throw new Error('Source and decoded segment counts differ.');

  const permanent = buildExactBoundaryPermanentTrackMaps(sourceSegments);
  const layout = buildCroppedMortonLayout(sourceSegments, permanent, manifest.crop.center, manifest.crop.halfExtent);
  if (layout.droppedTrackCount !== 0) throw new Error(`Full-value audit refuses cropped tracks: ${layout.droppedTrackCount} tracks are missing.`);

  const attributeStats = new Map();
  const propertyStats = new Map();
  const segmentAttributeStats = new Map();
  const semanticStats = {
    positionEuclidean: makeStats('positionEuclidean', 'meter'),
    rotationAngle: makeStats('rotationAngle', 'degree'),
    rotationComponentSignAligned: makeStats('rotationComponentSignAligned', 'normalized-component'),
    scaleRelativeRadius: makeStats('scaleRelativeRadius', 'ratio'),
    dcRgb: makeStats('dcRgb', 'linear-rgb'),
    opacityAlpha: makeStats('opacityAlpha', 'alpha'),
  };
  const semanticCounts = { rotationSignFlipQuaternions: 0 };
  const storageModes = { physical: 0, alias: 0, 'implicit-zero': 0 };
  const segmentResults = [];
  let sourceScalarValues = 0;
  let decodedPhysicalScalarValues = 0;

  for (let segmentIndex = 0; segmentIndex < sourceSegments.length; segmentIndex += 1) {
    const source = sourceSegments[segmentIndex];
    const decoded = decodedSegments[segmentIndex];
    const segmentName = basename(source.path);
    const activeSlots = layout.activeSlots[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    if (decoded.count !== activeSlots.length || source.count !== activeSlots.length) {
      throw new Error(`${segmentName} row coverage mismatch: source=${source.count}, decoded=${decoded.count}, layout=${activeSlots.length}.`);
    }
    const propertyPlans = source.propertyNames.map((sourceName) => {
      const decodedName = decoded.propertyIndex.has(sourceName) ? sourceName : reconstructedProperty(sourceName);
      const decodedProperty = decodedName === null ? -1 : decoded.propertyIndex.get(decodedName);
      if (decodedName !== null && decodedProperty === undefined) throw new Error(`${segmentName} cannot reconstruct ${sourceName} from ${decodedName}.`);
      const attribute = attributeForProperty(sourceName);
      const property = propertyStats.get(sourceName) ?? makeStats(sourceName, 'source-native');
      const attributeAccumulator = attributeStats.get(attribute) ?? makeStats(attribute, 'source-native');
      propertyStats.set(sourceName, property);
      attributeStats.set(attribute, attributeAccumulator);
      const segmentKey = `${segmentName}:${attribute}`;
      const segmentAttribute = segmentAttributeStats.get(segmentKey) ?? makeStats(segmentKey, 'source-native');
      segmentAttributeStats.set(segmentKey, segmentAttribute);
      return { sourceName, sourceProperty: source.propertyIndex.get(sourceName), decodedName, decodedProperty, attribute, property, attributeAccumulator, segmentAttribute, mode: aliasMode(sourceName, decodedName) };
    });
    for (const plan of propertyPlans) storageModes[plan.mode] += source.count;

    process.stderr.write(`Audit ${segmentIndex + 1}/${sourceSegments.length}: ${segmentName}, ${source.count.toLocaleString()} rows x ${source.propertyNames.length} values...\n`);
    for (let decodedRow = 0; decodedRow < decoded.count; decodedRow += 1) {
      const slot = activeSlots[decodedRow];
      const sourceRow = inverse[slot];
      const sourceBase = sourceRow * source.propertyNames.length;
      const decodedBase = decodedRow * decoded.propertyNames.length;
      for (const plan of propertyPlans) {
        const sourceBits = source.rows[sourceBase + plan.sourceProperty];
        const decodedBits = plan.decodedProperty < 0 ? 0 : decoded.rows[decodedBase + plan.decodedProperty];
        const sourceValue = halfTable[sourceBits];
        const decodedValue = halfTable[decodedBits];
        const location = { segment: segmentName, sourceRow, decodedRow, permanentTrack: slot, property: plan.sourceName, decodedProperty: plan.decodedName ?? 'implicit +0' };
        const exact = sourceBits === decodedBits;
        record(plan.property, sourceValue, decodedValue, exact, location);
        record(plan.attributeAccumulator, sourceValue, decodedValue, exact, location);
        record(plan.segmentAttribute, sourceValue, decodedValue, exact, location);
        if (plan.attribute === 'scale') {
          record(semanticStats.scaleRelativeRadius, 0, Math.abs(Math.expm1(decodedValue - sourceValue)), exact, location);
        } else if (plan.attribute === 'dc') {
          record(semanticStats.dcRgb, 0, Math.abs(decodedValue - sourceValue) * SH_C0, exact, location);
        } else if (plan.attribute === 'opacity') {
          const sourceAlpha = sourceValue >= 0 ? 1 / (1 + Math.exp(-sourceValue)) : Math.exp(sourceValue) / (1 + Math.exp(sourceValue));
          const decodedAlpha = decodedValue >= 0 ? 1 / (1 + Math.exp(-decodedValue)) : Math.exp(decodedValue) / (1 + Math.exp(decodedValue));
          record(semanticStats.opacityAlpha, sourceAlpha, decodedAlpha, exact, location);
        }
      }
      recordSemanticVectors(source, decoded, sourceBase, decodedBase, source.propertyIndex, decoded.propertyIndex, segmentName, sourceRow, slot, semanticStats, semanticCounts);
    }
    sourceScalarValues += source.count * source.propertyNames.length;
    decodedPhysicalScalarValues += decoded.count * decoded.propertyNames.length;
    segmentResults.push({
      name: segmentName,
      sourceRows: source.count,
      decodedRows: decoded.count,
      sourceProperties: source.propertyNames.length,
      decodedPhysicalProperties: decoded.propertyNames.length,
      sourceScalarValues: source.count * source.propertyNames.length,
      decodedPhysicalScalarValues: decoded.count * decoded.propertyNames.length,
      logicalCoverageRate: 1,
    });
  }

  const sourceFiles = await Promise.all(sourceSegments.map(async (segment) => ({ path: segment.path, bytes: (await stat(segment.path)).size })));
  const decodedFiles = await Promise.all(decodedSegments.map(async (segment) => ({ path: segment.path, bytes: (await stat(segment.path)).size })));
  const finished = performance.now();
  const result = {
    schema: 'fourcgs-value-error-audit-v1',
    generatedAt: new Date().toISOString(),
    inputs: {
      sourceDirectory,
      decodedDirectory,
      containerPath,
      containerBytes: containerBytes.length,
      containerSha256: sha256(containerBytes),
      sourceFiles,
      decodedFiles,
    },
    coverage: {
      segmentCount: sourceSegments.length,
      permanentTrackCount: layout.slotCount,
      droppedTrackCount: layout.droppedTrackCount,
      sourceRows: sourceSegments.reduce((sum, segment) => sum + segment.count, 0),
      decodedRows: decodedSegments.reduce((sum, segment) => sum + segment.count, 0),
      sourcePropertiesPerRow: sourceSegments[0].propertyNames.length,
      decodedPhysicalPropertiesPerRow: decodedSegments[0].propertyNames.length,
      sourceScalarValues,
      comparedLogicalScalarValues: sourceScalarValues,
      decodedPhysicalScalarValues,
      reconstructedScalarValues: sourceScalarValues - decodedPhysicalScalarValues,
      storageModes,
      comparisonCoverageRate: 1,
      note: 'Every FP16 scalar in all six source files is compared. Omitted redundant base fields are reconstructed from bank 0; nx/ny/nz are reconstructed as +0.',
    },
    histogramDefinition: {
      type: 'absolute-error logarithmic',
      exactZeroSeparate: true,
      minimumLog10: HISTOGRAM_MIN_LOG10,
      maximumLog10: HISTOGRAM_MAX_LOG10,
      binsPerDecade: HISTOGRAM_BINS_PER_DECADE,
      quantiles: 'deterministic histogram upper bounds; p100 is exact',
    },
    segments: segmentResults,
    attributes: Object.fromEntries([...attributeStats].map(([name, stats]) => [name, finishStats(stats)])),
    semanticMetrics: Object.fromEntries(Object.entries(semanticStats).map(([name, stats]) => [name, finishStats(stats)])),
    semanticCounts,
    semanticNotes: {
      rotation: 'Raw quaternion component errors include mathematically equivalent q/-q sign changes. Use rotationAngle for orientation error and rotationComponentSignAligned for component error after normalization and sign alignment.',
      duplicateBaseFields: 'x/y/z, f_dc_*, opacity, and scale_* are source-level aliases of bank 0 and are deliberately counted because this audit covers every source scalar.',
    },
    properties: Object.fromEntries([...propertyStats].map(([name, stats]) => [name, finishStats(stats)])),
    segmentAttributes: Object.fromEntries([...segmentAttributeStats].map(([name, stats]) => [name, finishStats(stats)])),
    elapsedSeconds: (finished - started) / 1000,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, coverage: result.coverage, elapsedSeconds: result.elapsedSeconds })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
