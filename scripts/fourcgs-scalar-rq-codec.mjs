import { unzlibSync, zlibSync } from 'fflate';
import { floatToHalf, halfToFloat } from './fourcgs-prs-codec.mjs';

const MAGIC = 'MIXSC001';
const HEADER_BYTES = 48;
const TRANSFORMS = { identity: 0, opacityAlpha: 1 };
const TRANSFORM_NAMES = ['identity', 'opacityAlpha'];

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function logit(value) {
  const bounded = Math.max(1e-6, Math.min(1 - 1e-6, value));
  return Math.log(bounded / (1 - bounded));
}

function toDomain(bits, transform) {
  const value = halfToFloat(bits);
  return transform === TRANSFORMS.opacityAlpha ? sigmoid(value) : value;
}

function fromDomain(value, transform) {
  return floatToHalf(transform === TRANSFORMS.opacityAlpha ? logit(value) : value);
}

function nearest(sortedCentroids, value) {
  let low = 0;
  let high = sortedCentroids.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedCentroids[middle] < value) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  if (low === sortedCentroids.length) return sortedCentroids.length - 1;
  return value - sortedCentroids[low - 1] <= sortedCentroids[low] - value ? low - 1 : low;
}

function trainScalarCodebook(valueAt, observationCount, bits, requestedSamples) {
  const codeCount = 1 << bits;
  const sampleCount = Math.min(observationCount, Math.max(codeCount * 2, requestedSamples));
  const samples = new Float32Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const observation = Math.min(observationCount - 1, Math.floor((sample + 0.5) * observationCount / sampleCount));
    samples[sample] = valueAt(observation);
  }
  samples.sort();
  let centroids = new Float32Array(codeCount);
  for (let code = 0; code < codeCount; code += 1) {
    centroids[code] = halfToFloat(floatToHalf(samples[Math.min(sampleCount - 1, Math.floor((code + 0.5) * sampleCount / codeCount))]));
  }
  centroids.sort();
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const sums = new Float64Array(codeCount);
    const counts = new Uint32Array(codeCount);
    for (const value of samples) {
      const code = nearest(centroids, value);
      sums[code] += value;
      counts[code] += 1;
    }
    for (let code = 0; code < codeCount; code += 1) {
      if (counts[code] > 0) centroids[code] = halfToFloat(floatToHalf(sums[code] / counts[code]));
    }
    centroids.sort();
  }
  return { centroids, sampleCount };
}

class BitWriter {
  constructor(totalBits) {
    this.bytes = Buffer.alloc(Math.ceil(totalBits / 8));
    this.offset = 0;
    this.accumulator = 0;
    this.accumulatorBits = 0;
  }

  write(value, bits) {
    this.accumulator += value * (2 ** this.accumulatorBits);
    this.accumulatorBits += bits;
    while (this.accumulatorBits >= 8) {
      this.bytes[this.offset++] = this.accumulator & 0xff;
      this.accumulator = Math.floor(this.accumulator / 256);
      this.accumulatorBits -= 8;
    }
  }

  finish() {
    if (this.accumulatorBits > 0) this.bytes[this.offset++] = this.accumulator & 0xff;
    if (this.offset !== this.bytes.length) throw new Error(`Scalar RQ bit writer mismatch: ${this.offset} != ${this.bytes.length}`);
    return this.bytes;
  }
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
    this.accumulator = 0;
    this.accumulatorBits = 0;
  }

  read(bits) {
    while (this.accumulatorBits < bits) {
      if (this.offset >= this.bytes.length) throw new Error('Truncated scalar RQ labels.');
      this.accumulator += this.bytes[this.offset++] * (2 ** this.accumulatorBits);
      this.accumulatorBits += 8;
    }
    const divisor = 2 ** bits;
    const value = this.accumulator % divisor;
    this.accumulator = Math.floor(this.accumulator / divisor);
    this.accumulatorBits -= bits;
    return value;
  }
}

// #WDD-gpt 2026-08-15 - 按公开 MINT 位布局实现逐属性 8/10/12-bit 半精度码表标签、时间基准残差与逐值有界原值修复。
export function encodeScalarRq(sourceBits, observationCount, dimensions, options) {
  if (sourceBits.length !== observationCount * dimensions) throw new Error('Scalar RQ source dimensions do not match.');
  if (options.bitsByDimension.length !== dimensions || options.predictors.length !== dimensions) {
    throw new Error('Scalar RQ dimension policy does not match.');
  }
  const transform = TRANSFORMS[options.transform ?? 'identity'];
  if (transform === undefined) throw new Error(`Unsupported scalar RQ transform ${options.transform}.`);
  const decodedBits = new Uint16Array(sourceBits.length);
  const totalLabelBits = observationCount * options.bitsByDimension.reduce((sum, bits) => sum + bits, 0);
  const labelWriter = new BitWriter(totalLabelBits);
  const exceptionMask = new Uint8Array(Math.ceil(sourceBits.length / 8));
  const exceptionValues = [];
  const modelParts = [];
  const dimensionMetrics = [];
  let exceptionCount = 0;
  let maximumError = 0;
  let squareError = 0;
  let preRepairMaximumError = 0;
  let preRepairSquareError = 0;
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    const bits = options.bitsByDimension[dimension];
    const predictor = options.predictors[dimension];
    if (predictor >= dimension) throw new Error(`Scalar RQ predictor ${predictor} must precede dimension ${dimension}.`);
    const valueAt = (observation) => {
      const offset = observation * dimensions;
      const target = toDomain(sourceBits[offset + dimension], transform);
      const base = predictor >= 0 ? toDomain(decodedBits[offset + predictor], transform) : 0;
      return target - base;
    };
    const { centroids, sampleCount } = trainScalarCodebook(
      valueAt,
      observationCount,
      bits,
      options.sampleCount ?? 32768,
    );
    const modelHeader = Buffer.alloc(4);
    modelHeader.writeUInt8(bits, 0);
    modelHeader.writeInt16LE(predictor, 1);
    modelHeader.writeUInt8(0, 3);
    const centroidBytes = Buffer.alloc(centroids.length * 2);
    for (let code = 0; code < centroids.length; code += 1) centroidBytes.writeUInt16LE(floatToHalf(centroids[code]), code * 2);
    modelParts.push(modelHeader, centroidBytes);
    let dimensionExceptions = 0;
    let dimensionMaximum = 0;
    for (let observation = 0; observation < observationCount; observation += 1) {
      const offset = observation * dimensions;
      const source = toDomain(sourceBits[offset + dimension], transform);
      const base = predictor >= 0 ? toDomain(decodedBits[offset + predictor], transform) : 0;
      const code = nearest(centroids, source - base);
      labelWriter.write(code, bits);
      let decoded = fromDomain(base + centroids[code], transform);
      const preRepairError = Math.abs(source - toDomain(decoded, transform));
      preRepairMaximumError = Math.max(preRepairMaximumError, preRepairError);
      preRepairSquareError += preRepairError * preRepairError;
      const flat = dimension * observationCount + observation;
      if (!Number.isFinite(preRepairError) || preRepairError > options.maximumError) {
        exceptionMask[flat >>> 3] |= 1 << (flat & 7);
        const original = sourceBits[offset + dimension];
        exceptionValues.push(original & 0xff, original >>> 8);
        decoded = original;
        exceptionCount += 1;
        dimensionExceptions += 1;
      }
      decodedBits[offset + dimension] = decoded;
      const error = Math.abs(source - toDomain(decoded, transform));
      maximumError = Math.max(maximumError, error);
      dimensionMaximum = Math.max(dimensionMaximum, error);
      squareError += error * error;
    }
    dimensionMetrics.push({
      dimension,
      bits,
      predictor,
      sampleCount,
      exceptionCount: dimensionExceptions,
      exceptionRatio: dimensionExceptions / observationCount,
      measuredMaximumError: dimensionMaximum,
    });
  }
  const rawLabels = labelWriter.finish();
  // #WDD-gpt 2026-08-16 - Scalar RQ 改用浏览器原生可打包的 fflate，避免 Worker 运行时依赖被 Vite 外置的 node:zlib。
  const storedLabels = zlibSync(rawLabels, { level: 9 });
  const storedMask = zlibSync(exceptionMask, { level: 9 });
  const storedExceptions = zlibSync(Buffer.from(exceptionValues), { level: 9 });
  const modelBytes = Buffer.concat(modelParts);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(observationCount, 8);
  header.writeUInt16LE(dimensions, 12);
  header.writeUInt8(transform, 14);
  header.writeUInt8(0, 15);
  header.writeFloatLE(options.maximumError, 16);
  header.writeUInt32LE(modelBytes.length, 20);
  header.writeUInt32LE(storedLabels.length, 24);
  header.writeUInt32LE(storedMask.length, 28);
  header.writeUInt32LE(storedExceptions.length, 32);
  header.writeUInt32LE(exceptionCount, 36);
  header.writeUInt32LE(sourceBits.byteLength, 40);
  header.writeUInt32LE(rawLabels.length, 44);
  const encoded = Buffer.concat([header, modelBytes, storedLabels, storedMask, storedExceptions]);
  return {
    encoded,
    decodedBits,
    metrics: {
      observationCount,
      dimensions,
      transform: TRANSFORM_NAMES[transform],
      maximumAllowedError: options.maximumError,
      measuredRmse: Math.sqrt(squareError / sourceBits.length),
      measuredMaximumError: maximumError,
      preRepairRmse: Math.sqrt(preRepairSquareError / sourceBits.length),
      preRepairMaximumError,
      exceptionCount,
      exceptionRatio: exceptionCount / sourceBits.length,
      sourceBytes: sourceBits.byteLength,
      modelBytes: modelBytes.length,
      rawLabelBytes: rawLabels.length,
      labelBytes: storedLabels.length,
      exceptionMaskBytes: storedMask.length,
      exceptionValueBytes: storedExceptions.length,
      encodedBytes: HEADER_BYTES + modelBytes.length + storedLabels.length + storedMask.length + storedExceptions.length,
      compressionRatio: sourceBits.byteLength / (HEADER_BYTES + modelBytes.length + storedLabels.length + storedMask.length + storedExceptions.length),
      dimensionMetrics,
    },
  };
}

export function decodeScalarRq(encoded) {
  if (encoded.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported scalar RQ stream.');
  const observationCount = encoded.readUInt32LE(8);
  const dimensions = encoded.readUInt16LE(12);
  const transform = encoded.readUInt8(14);
  const maximumError = encoded.readFloatLE(16);
  const modelBytes = encoded.readUInt32LE(20);
  const labelBytes = encoded.readUInt32LE(24);
  const maskBytes = encoded.readUInt32LE(28);
  const exceptionBytes = encoded.readUInt32LE(32);
  const exceptionCount = encoded.readUInt32LE(36);
  const decodedBytes = encoded.readUInt32LE(40);
  const rawLabelBytes = encoded.readUInt32LE(44);
  if (!TRANSFORM_NAMES[transform] || decodedBytes !== observationCount * dimensions * 2) throw new Error('Invalid scalar RQ metadata.');
  let offset = HEADER_BYTES;
  const modelEnd = offset + modelBytes;
  const models = [];
  while (offset < modelEnd) {
    const bits = encoded.readUInt8(offset);
    const predictor = encoded.readInt16LE(offset + 1);
    offset += 4;
    const centroids = new Float32Array(1 << bits);
    for (let code = 0; code < centroids.length; code += 1) {
      centroids[code] = halfToFloat(encoded.readUInt16LE(offset));
      offset += 2;
    }
    models.push({ bits, predictor, centroids });
  }
  if (offset !== modelEnd || models.length !== dimensions) throw new Error('Invalid scalar RQ model bytes.');
  const labels = unzlibSync(encoded.subarray(offset, offset + labelBytes));
  offset += labelBytes;
  const mask = unzlibSync(encoded.subarray(offset, offset + maskBytes));
  offset += maskBytes;
  const exceptions = unzlibSync(encoded.subarray(offset, offset + exceptionBytes));
  offset += exceptionBytes;
  if (offset !== encoded.length || labels.length !== rawLabelBytes || mask.length !== Math.ceil(observationCount * dimensions / 8)) {
    throw new Error('Invalid scalar RQ payload bytes.');
  }
  const labelReader = new BitReader(labels);
  const bits = new Uint16Array(observationCount * dimensions);
  let exceptionOffset = 0;
  let appliedExceptions = 0;
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    const model = models[dimension];
    for (let observation = 0; observation < observationCount; observation += 1) {
      const offsetBits = observation * dimensions;
      const code = labelReader.read(model.bits);
      const base = model.predictor >= 0 ? toDomain(bits[offsetBits + model.predictor], transform) : 0;
      let decoded = fromDomain(base + model.centroids[code], transform);
      const flat = dimension * observationCount + observation;
      if ((mask[flat >>> 3] & (1 << (flat & 7))) !== 0) {
        decoded = exceptions[exceptionOffset] | (exceptions[exceptionOffset + 1] << 8);
        exceptionOffset += 2;
        appliedExceptions += 1;
      }
      bits[offsetBits + dimension] = decoded;
    }
  }
  if (appliedExceptions !== exceptionCount || exceptionOffset !== exceptions.length) throw new Error('Scalar RQ exception count mismatch.');
  return {
    bits,
    metrics: {
      observationCount,
      dimensions,
      transform: TRANSFORM_NAMES[transform],
      maximumError,
      appliedExceptions,
    },
  };
}
