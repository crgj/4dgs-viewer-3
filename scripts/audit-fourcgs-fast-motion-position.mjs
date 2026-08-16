import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  bankCount,
  buildExactBoundaryPermanentTrackMaps,
  readSegment,
} from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, halfToFloat } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const ERROR_HISTOGRAM_BINS = 4096;
const ERROR_HISTOGRAM_MAX_METERS = 0.002;

function manifestFromContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== '4CGSPRS2') {
    throw new Error('Unsupported 4CGS container magic.');
  }
  const manifestBytes = bytes.readUInt32LE(8);
  return JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
}

function keyframes(totalFrames, keyCount) {
  if (keyCount <= 1) return [0];
  const stride = Math.max(1, Math.ceil((totalFrames - 1) / (keyCount - 1)));
  return Array.from({ length: keyCount }, (_, index) => (
    index === keyCount - 1 ? totalFrames - 1 : Math.min(totalFrames - 1, index * stride)
  ));
}

function span(keys, frame) {
  if (frame <= keys[0]) return { left: 0, right: 0, alpha: 0 };
  const last = keys.length - 1;
  if (frame >= keys[last]) return { left: last, right: last, alpha: 0 };
  let right = 1;
  while (frame > keys[right]) right += 1;
  const left = right - 1;
  return {
    left,
    right,
    alpha: (frame - keys[left]) / (keys[right] - keys[left]),
  };
}

function positionIndices(segment) {
  return Array.from({ length: bankCount(segment, 'xyz_bank') }, (_, bank) => (
    ['x', 'y', 'z'].map((axis) => segment.propertyIndex.get(`xyz_bank_${bank}_${axis}`))
  ));
}

function interpolatePosition(rows, stride, row, indices, frameSpan, halfTable, output) {
  const base = row * stride;
  const left = indices[frameSpan.left];
  const right = indices[frameSpan.right];
  const alpha = frameSpan.alpha;
  for (let axis = 0; axis < 3; axis += 1) {
    const a = halfTable[rows[base + left[axis]]];
    const b = halfTable[rows[base + right[axis]]];
    output[axis] = a + (b - a) * alpha;
  }
}

function percentileFromHistogram(histogram, count, percentile) {
  const target = Math.max(1, Math.ceil(count * percentile));
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    cumulative += histogram[bin];
    if (cumulative >= target) return (bin + 1) * ERROR_HISTOGRAM_MAX_METERS / histogram.length;
  }
  return ERROR_HISTOGRAM_MAX_METERS;
}

function frameMetrics(source, decoded, sourceRows, sourceIndices, decodedIndices, keys, frame, halfTable) {
  const frameSpan = span(keys, frame);
  const previousSpan = span(keys, Math.max(0, frame - 1));
  const histogram = new Uint32Array(ERROR_HISTOGRAM_BINS);
  const sourcePosition = [0, 0, 0];
  const previousPosition = [0, 0, 0];
  const decodedPosition = [0, 0, 0];
  let errorSum = 0;
  let errorSquaredSum = 0;
  let speedSum = 0;
  let speedSquaredSum = 0;
  let errorSpeedSum = 0;
  let maximumError = 0;
  let maximumSpeed = 0;
  for (let row = 0; row < decoded.count; row += 1) {
    const sourceRow = sourceRows[row];
    interpolatePosition(
      source.rows, source.propertyNames.length, sourceRow, sourceIndices, frameSpan, halfTable, sourcePosition,
    );
    interpolatePosition(
      decoded.rows, decoded.propertyNames.length, row, decodedIndices, frameSpan, halfTable, decodedPosition,
    );
    interpolatePosition(
      source.rows, source.propertyNames.length, sourceRow, sourceIndices, previousSpan, halfTable, previousPosition,
    );
    const error = Math.hypot(
      decodedPosition[0] - sourcePosition[0],
      decodedPosition[1] - sourcePosition[1],
      decodedPosition[2] - sourcePosition[2],
    );
    const speed = Math.hypot(
      sourcePosition[0] - previousPosition[0],
      sourcePosition[1] - previousPosition[1],
      sourcePosition[2] - previousPosition[2],
    );
    const bin = Math.min(
      ERROR_HISTOGRAM_BINS - 1,
      Math.floor(error / ERROR_HISTOGRAM_MAX_METERS * ERROR_HISTOGRAM_BINS),
    );
    histogram[bin] += 1;
    errorSum += error;
    errorSquaredSum += error * error;
    speedSum += speed;
    speedSquaredSum += speed * speed;
    errorSpeedSum += error * speed;
    maximumError = Math.max(maximumError, error);
    maximumSpeed = Math.max(maximumSpeed, speed);
  }
  const count = decoded.count;
  const meanError = errorSum / count;
  const meanSpeed = speedSum / count;
  const covariance = errorSpeedSum / count - meanError * meanSpeed;
  const errorVariance = errorSquaredSum / count - meanError * meanError;
  const speedVariance = speedSquaredSum / count - meanSpeed * meanSpeed;
  return {
    frame,
    isStoredPositionKey: keys.includes(frame),
    pointCount: count,
    meanMotionMetersPerFrame: meanSpeed,
    maximumMotionMetersPerFrame: maximumSpeed,
    positionMeanErrorMeters: meanError,
    positionRmseMeters: Math.sqrt(errorSquaredSum / count),
    positionP95ErrorMeters: percentileFromHistogram(histogram, count, 0.95),
    positionP99ErrorMeters: percentileFromHistogram(histogram, count, 0.99),
    positionP999ErrorMeters: percentileFromHistogram(histogram, count, 0.999),
    positionMaximumErrorMeters: maximumError,
    errorMotionPearson: errorVariance > 0 && speedVariance > 0
      ? covariance / Math.sqrt(errorVariance * speedVariance)
      : 0,
  };
}

function boundaryMetrics(previous, current, previousDecoded, currentDecoded, previousSourceRows, currentSourceRows, halfTable) {
  const previousIndices = positionIndices(previous);
  const currentIndices = positionIndices(current);
  const previousDecodedIndices = positionIndices(previousDecoded);
  const currentDecodedIndices = positionIndices(currentDecoded);
  const previousBank = previousIndices.length - 1;
  let sharedCount = 0;
  let sourceMaximum = 0;
  let decodedMaximum = 0;
  for (let previousRow = 0; previousRow < previousDecoded.count; previousRow += 1) {
    const previousSourceRow = previousSourceRows[previousRow];
    const slot = previousDecoded.__activeSlots[previousRow];
    const currentRow = currentDecoded.__slotToRow[slot];
    if (currentRow < 0) continue;
    const currentSourceRow = currentSourceRows[currentRow];
    let sourceSquared = 0;
    let decodedSquared = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const sourcePrevious = halfTable[previous.rows[
        previousSourceRow * previous.propertyNames.length + previousIndices[previousBank][axis]
      ]];
      const sourceCurrent = halfTable[current.rows[
        currentSourceRow * current.propertyNames.length + currentIndices[0][axis]
      ]];
      const decodedPrevious = halfTable[previousDecoded.rows[
        previousRow * previousDecoded.propertyNames.length + previousDecodedIndices[previousBank][axis]
      ]];
      const decodedCurrent = halfTable[currentDecoded.rows[
        currentRow * currentDecoded.propertyNames.length + currentDecodedIndices[0][axis]
      ]];
      sourceSquared += (sourcePrevious - sourceCurrent) ** 2;
      decodedSquared += (decodedPrevious - decodedCurrent) ** 2;
    }
    sourceMaximum = Math.max(sourceMaximum, Math.sqrt(sourceSquared));
    decodedMaximum = Math.max(decodedMaximum, Math.sqrt(decodedSquared));
    sharedCount += 1;
  }
  return { sharedCount, sourceMaximumBoundaryGapMeters: sourceMaximum, decodedMaximumBoundaryGapMeters: decodedMaximum };
}

// #WDD-gpt 2026-08-16 - 对所有 180 帧逐点复核 Position，区分位流量化误差、快速运动相关性和跨段 Track 错配。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const decodedDirectory = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/v23_final_decoded');
  const containerPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const outputPath = resolve(process.argv[5] ?? 'artifacts/compression_v2_20260816/V24_FAST_MOTION_POSITION_AUDIT.json');
  const started = performance.now();
  const sourceNames = (await readdir(sourceDirectory))
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  if (sourceNames.length !== 6) throw new Error(`Expected six source segments, found ${sourceNames.length}.`);
  const sources = [];
  const decoded = [];
  for (const sourceName of sourceNames) {
    sources.push(await readSegment(join(sourceDirectory, sourceName)));
    decoded.push(await readSegment(join(decodedDirectory, `${sourceName.replace(/\.raw4d$/, '')}.decoded.raw4d`)));
  }
  const manifest = manifestFromContainer(await readFile(containerPath));
  const permanent = buildExactBoundaryPermanentTrackMaps(sources);
  const layout = buildCroppedMortonLayout(sources, permanent, manifest.crop.center, manifest.crop.halfExtent);
  if (layout.slotCount !== manifest.slotCount) throw new Error('Permanent Track layout does not match the container.');
  const halfTable = new Float32Array(65536);
  for (let bits = 0; bits < halfTable.length; bits += 1) halfTable[bits] = halfToFloat(bits);
  const segments = [];
  const sourceRowsBySegment = [];
  for (let segmentIndex = 0; segmentIndex < sources.length; segmentIndex += 1) {
    const source = sources[segmentIndex];
    const restored = decoded[segmentIndex];
    const activeSlots = layout.activeSlots[segmentIndex];
    if (restored.count !== activeSlots.length) throw new Error(`Decoded row count mismatch in segment ${segmentIndex}.`);
    const sourceRows = Int32Array.from(activeSlots, (slot) => layout.slotToLocal[segmentIndex][slot]);
    const slotToRow = new Int32Array(layout.slotCount);
    slotToRow.fill(-1);
    activeSlots.forEach((slot, row) => { slotToRow[slot] = row; });
    restored.__activeSlots = activeSlots;
    restored.__slotToRow = slotToRow;
    sourceRowsBySegment.push(sourceRows);
    const totalFrames = manifest.segments[segmentIndex].totalFrames;
    const keys = keyframes(totalFrames, bankCount(source, 'xyz_bank'));
    const frames = [];
    const sourceIndices = positionIndices(source);
    const decodedIndices = positionIndices(restored);
    for (let frame = 0; frame < totalFrames; frame += 1) {
      const metrics = frameMetrics(
        source, restored, sourceRows, sourceIndices, decodedIndices, keys, frame, halfTable,
      );
      frames.push(metrics);
      process.stderr.write(
        `\r${basename(source.path)} frame ${String(frame).padStart(2, '0')}/${totalFrames - 1}`,
      );
    }
    process.stderr.write('\n');
    segments.push({
      name: manifest.segments[segmentIndex].name,
      totalFrames,
      positionKeyframes: keys,
      gaussianCount: restored.count,
      frames,
    });
  }
  const boundaries = [];
  for (let segmentIndex = 1; segmentIndex < sources.length; segmentIndex += 1) {
    boundaries.push({
      previous: manifest.segments[segmentIndex - 1].name,
      current: manifest.segments[segmentIndex].name,
      ...boundaryMetrics(
        sources[segmentIndex - 1], sources[segmentIndex], decoded[segmentIndex - 1], decoded[segmentIndex],
        sourceRowsBySegment[segmentIndex - 1], sourceRowsBySegment[segmentIndex], halfTable,
      ),
    });
  }
  const allFrames = segments.flatMap((segment, segmentIndex) => segment.frames.map((frame) => ({ segmentIndex, ...frame })));
  const fastestFrames = [...allFrames]
    .sort((left, right) => right.meanMotionMetersPerFrame - left.meanMotionMetersPerFrame)
    .slice(0, 20);
  const largestErrorFrames = [...allFrames]
    .sort((left, right) => right.positionMaximumErrorMeters - left.positionMaximumErrorMeters)
    .slice(0, 20);
  const result = {
    version: '4CGS V2.4 full-frame fast-motion position audit',
    sourceDirectory,
    decodedDirectory,
    containerPath,
    note: 'V2.4 reuses V2.3 final stored streams byte-for-byte; V2.3 final decoded RAW4D is therefore the decoded payload under test.',
    manifestSlotCount: manifest.slotCount,
    droppedTrackCount: layout.droppedTrackCount,
    totalComparedFrames: allFrames.length,
    fastestFrames,
    largestErrorFrames,
    globalMaximumPositionErrorMeters: Math.max(...allFrames.map((frame) => frame.positionMaximumErrorMeters)),
    maximumP999PositionErrorMeters: Math.max(...allFrames.map((frame) => frame.positionP999ErrorMeters)),
    maximumAbsoluteErrorMotionPearson: Math.max(...allFrames.map((frame) => Math.abs(frame.errorMotionPearson))),
    boundaries,
    permanentTrackMatches: permanent.matches,
    segments,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    totalComparedFrames: result.totalComparedFrames,
    globalMaximumPositionErrorMeters: result.globalMaximumPositionErrorMeters,
    maximumP999PositionErrorMeters: result.maximumP999PositionErrorMeters,
    maximumAbsoluteErrorMotionPearson: result.maximumAbsoluteErrorMotionPearson,
    boundaries,
    fastestFrames: fastestFrames.slice(0, 5),
    elapsedSeconds: result.elapsedSeconds,
  }));
}

await main();
