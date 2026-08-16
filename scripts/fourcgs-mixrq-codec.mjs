import { deflateSync, inflateSync } from 'node:zlib';
import { floatToHalf, halfToFloat } from './fourcgs-prs-codec.mjs';

const MAGIC = 'MIXRQ001';
const WINDOW_MAGIC = 'MIXWIN01';
const HEADER_BYTES = 48;
const TRANSFORMS = {
  identity: 0,
  opacityAlpha: 1,
};
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

function nearestSiblingLabel(values, offset, dimensions, model) {
  let group = 0;
  let groupDistance = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < 16; candidate += 1) {
    let distance = 0;
    const centroidOffset = candidate * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const difference = values[offset + dimension] - model.coarseCentroids[centroidOffset + dimension];
      distance += difference * difference;
    }
    if (distance < groupDistance) {
      groupDistance = distance;
      group = candidate;
    }
  }
  const first = group << 4;
  let best = first;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let label = first; label < first + 16; label += 1) {
    const centroidOffset = label * dimensions;
    let distance = 0;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const difference = values[offset + dimension] - model.centroids[centroidOffset + dimension];
      distance += difference * difference;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = label;
    }
  }
  return best;
}

function trainKMeans(samples, indices, dimensions, clusterCount, iterations, seedOffset = 0) {
  const centroids = new Float32Array(clusterCount * dimensions);
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const source = indices[(cluster * 7919 + seedOffset * 104729) % indices.length];
    centroids.set(samples.subarray(source * dimensions, source * dimensions + dimensions), cluster * dimensions);
  }
  const assignments = new Uint16Array(indices.length);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sums = new Float64Array(clusterCount * dimensions);
    const counts = new Uint32Array(clusterCount);
    for (let item = 0; item < indices.length; item += 1) {
      const sourceOffset = indices[item] * dimensions;
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        const centroidOffset = cluster * dimensions;
        let distance = 0;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
          const difference = samples[sourceOffset + dimension] - centroids[centroidOffset + dimension];
          distance += difference * difference;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cluster;
        }
      }
      assignments[item] = best;
      counts[best] += 1;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        sums[best * dimensions + dimension] += samples[sourceOffset + dimension];
      }
    }
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      if (counts[cluster] === 0) continue;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        centroids[cluster * dimensions + dimension] = sums[cluster * dimensions + dimension] / counts[cluster];
      }
    }
  }
  return { centroids, assignments };
}

function buildTreeCodebook(samples, sampleCount, dimensions) {
  const all = Array.from({ length: sampleCount }, (_, index) => index);
  const coarse = trainKMeans(samples, all, dimensions, 16, 8);
  const groups = Array.from({ length: 16 }, () => []);
  for (let index = 0; index < all.length; index += 1) groups[coarse.assignments[index]].push(index);
  const centroids = new Float32Array(256 * dimensions);
  for (let group = 0; group < 16; group += 1) {
    const indices = groups[group].length > 0 ? groups[group] : all;
    const fine = trainKMeans(samples, indices, dimensions, 16, 6, group + 1);
    for (let cluster = 0; cluster < 16; cluster += 1) {
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        centroids[(group * 16 + cluster) * dimensions + dimension] = halfToFloat(
          floatToHalf(fine.centroids[cluster * dimensions + dimension]),
        );
      }
    }
  }
  return { coarseCentroids: coarse.centroids, centroids };
}

function subtractAssignedCentroids(values, count, dimensions, model, labels = null) {
  const outputLabels = labels ?? new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * dimensions;
    const label = nearestSiblingLabel(values, offset, dimensions, model);
    outputLabels[index] = label;
    const centroidOffset = label * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      values[offset + dimension] -= model.centroids[centroidOffset + dimension];
    }
  }
  return outputLabels;
}

function trainModels(domainValues, observationCount, dimensions, levels, requestedSamples) {
  const sampleCount = Math.min(observationCount, requestedSamples);
  const samples = new Float32Array(sampleCount * dimensions);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const observation = Math.min(observationCount - 1, Math.floor((sample + 0.5) * observationCount / sampleCount));
    samples.set(domainValues.subarray(observation * dimensions, observation * dimensions + dimensions), sample * dimensions);
  }
  const models = [];
  for (let level = 0; level < levels; level += 1) {
    const model = buildTreeCodebook(samples, sampleCount, dimensions);
    models.push(model);
    subtractAssignedCentroids(samples, sampleCount, dimensions, model);
  }
  return { models, sampleCount };
}

function serializeModels(models, dimensions, offsets, scales) {
  const bytes = Buffer.alloc(dimensions * 8 + models.length * 256 * dimensions * 2);
  let offset = 0;
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    bytes.writeFloatLE(offsets[dimension], offset);
    bytes.writeFloatLE(scales[dimension], offset + 4);
    offset += 8;
  }
  for (const model of models) {
    for (const value of model.centroids) {
      bytes.writeUInt16LE(floatToHalf(value), offset);
      offset += 2;
    }
  }
  return bytes;
}

function deserializeModels(bytes, levels, dimensions) {
  if (bytes.length !== dimensions * 8 + levels * 256 * dimensions * 2) throw new Error('Invalid MixRQ centroid byte count.');
  const models = [];
  const offsets = new Float32Array(dimensions);
  const scales = new Float32Array(dimensions);
  let offset = 0;
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    offsets[dimension] = bytes.readFloatLE(offset);
    scales[dimension] = bytes.readFloatLE(offset + 4);
    offset += 8;
  }
  for (let level = 0; level < levels; level += 1) {
    const centroids = new Float32Array(256 * dimensions);
    for (let index = 0; index < centroids.length; index += 1) {
      centroids[index] = halfToFloat(bytes.readUInt16LE(offset));
      offset += 2;
    }
    models.push({ centroids });
  }
  return { models, offsets, scales };
}

function serializeLabels(labels) {
  const parts = [];
  for (const level of labels) {
    const stored = deflateSync(level, { level: 9 });
    const header = Buffer.alloc(8);
    header.writeUInt32LE(level.length, 0);
    header.writeUInt32LE(stored.length, 4);
    parts.push(header, stored);
  }
  return Buffer.concat(parts);
}

function deserializeLabels(bytes, levels, observationCount) {
  const labels = [];
  let offset = 0;
  for (let level = 0; level < levels; level += 1) {
    if (offset + 8 > bytes.length) throw new Error('Truncated MixRQ label header.');
    const rawBytes = bytes.readUInt32LE(offset);
    const storedBytes = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (rawBytes !== observationCount || offset + storedBytes > bytes.length) throw new Error('Invalid MixRQ label byte count.');
    const raw = inflateSync(bytes.subarray(offset, offset + storedBytes));
    if (raw.length !== observationCount) throw new Error('Invalid MixRQ decoded label count.');
    labels.push(raw);
    offset += storedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unused MixRQ label bytes: ${bytes.length - offset}`);
  return labels;
}

function reconstructBits(models, labels, observationCount, dimensions, transform, offsets, scales, trajectoryComponents = 0) {
  const bits = new Uint16Array(observationCount * dimensions);
  for (let observation = 0; observation < observationCount; observation += 1) {
    const offset = observation * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      let value = 0;
      for (let level = 0; level < models.length; level += 1) {
        value += models[level].centroids[labels[level][observation] * dimensions + dimension];
      }
      let domain = offsets[dimension] + scales[dimension] * value;
      if (trajectoryComponents > 0 && dimension >= trajectoryComponents) {
        domain += toDomain(bits[offset + (dimension % trajectoryComponents)], transform);
      }
      bits[offset + dimension] = fromDomain(domain, transform);
    }
  }
  return bits;
}

// #WDD-gpt 2026-08-15 - 参照公开 MINT 的分属性 MixRQ 标签/半精度码表结构，并用有界原值例外保证几何与外观误差不越界。
export function encodeMixRq(sourceBits, observationCount, dimensions, options) {
  if (sourceBits.length !== observationCount * dimensions) throw new Error('MixRQ source dimensions do not match.');
  const transform = TRANSFORMS[options.transform ?? 'identity'];
  if (transform === undefined) throw new Error(`Unsupported MixRQ transform ${options.transform}.`);
  const levels = options.levels;
  const domainValues = new Float32Array(sourceBits.length);
  for (let index = 0; index < sourceBits.length; index += 1) domainValues[index] = toDomain(sourceBits[index], transform);
  const trajectoryComponents = options.trajectoryComponents ?? 0;
  if (trajectoryComponents < 0 || trajectoryComponents >= dimensions) throw new Error('Invalid MixRQ trajectory component count.');
  const transformedValues = domainValues.slice();
  if (trajectoryComponents > 0) {
    for (let observation = 0; observation < observationCount; observation += 1) {
      const offset = observation * dimensions;
      for (let dimension = trajectoryComponents; dimension < dimensions; dimension += 1) {
        transformedValues[offset + dimension] -= domainValues[offset + (dimension % trajectoryComponents)];
      }
    }
  }
  const offsets = new Float32Array(dimensions);
  const scales = new Float32Array(dimensions);
  const normalizationSamples = Math.min(observationCount, options.sampleCount ?? 8192);
  for (let sample = 0; sample < normalizationSamples; sample += 1) {
    const observation = Math.min(observationCount - 1, Math.floor((sample + 0.5) * observationCount / normalizationSamples));
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      offsets[dimension] += transformedValues[observation * dimensions + dimension] / normalizationSamples;
    }
  }
  for (let sample = 0; sample < normalizationSamples; sample += 1) {
    const observation = Math.min(observationCount - 1, Math.floor((sample + 0.5) * observationCount / normalizationSamples));
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const difference = transformedValues[observation * dimensions + dimension] - offsets[dimension];
      scales[dimension] += difference * difference / normalizationSamples;
    }
  }
  for (let dimension = 0; dimension < dimensions; dimension += 1) scales[dimension] = Math.max(1e-6, Math.sqrt(scales[dimension]));
  const normalizedValues = new Float32Array(domainValues.length);
  for (let observation = 0; observation < observationCount; observation += 1) {
    const offset = observation * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      normalizedValues[offset + dimension] = (transformedValues[offset + dimension] - offsets[dimension]) / scales[dimension];
    }
  }
  const { models, sampleCount } = trainModels(
    normalizedValues,
    observationCount,
    dimensions,
    levels,
    options.sampleCount ?? 8192,
  );
  const residuals = normalizedValues;
  const labels = models.map((model) => subtractAssignedCentroids(residuals, observationCount, dimensions, model));
  const decodedBits = reconstructBits(models, labels, observationCount, dimensions, transform, offsets, scales, trajectoryComponents);
  const exceptionMask = new Uint8Array(Math.ceil(sourceBits.length / 8));
  const exceptionValues = [];
  let exceptionCount = 0;
  let maximumError = 0;
  let squareError = 0;
  let preRepairMaximumError = 0;
  let preRepairSquareError = 0;
  const preRepairThresholdCounts = new Uint32Array(5);
  const preRepairThresholds = [0.005, 0.01, 0.02, 0.05, 0.1];
  let valueCount = 0;
  for (let observation = 0; observation < observationCount; observation += 1) {
    const offset = observation * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const flat = offset + dimension;
      const source = toDomain(sourceBits[offset + dimension], transform);
      const decoded = toDomain(decodedBits[offset + dimension], transform);
      const preRepairError = Math.abs(source - decoded);
      preRepairMaximumError = Math.max(preRepairMaximumError, preRepairError);
      preRepairSquareError += preRepairError * preRepairError;
      for (let threshold = 0; threshold < preRepairThresholds.length; threshold += 1) {
        if (preRepairError > preRepairThresholds[threshold]) preRepairThresholdCounts[threshold] += 1;
      }
      if (!Number.isFinite(preRepairError) || preRepairError > options.maximumError) {
        exceptionMask[flat >>> 3] |= 1 << (flat & 7);
        const bits = sourceBits[flat];
        exceptionValues.push(bits & 0xff, bits >>> 8);
        decodedBits[flat] = bits;
        exceptionCount += 1;
      }
      const repaired = toDomain(decodedBits[flat], transform);
      const error = Math.abs(source - repaired);
      maximumError = Math.max(maximumError, error);
      squareError += error * error;
      valueCount += 1;
    }
  }
  const modelBytes = serializeModels(models, dimensions, offsets, scales);
  const labelBytes = serializeLabels(labels);
  const storedMask = deflateSync(exceptionMask, { level: 9 });
  const storedExceptions = deflateSync(Buffer.from(exceptionValues), { level: 9 });
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(observationCount, 8);
  header.writeUInt16LE(dimensions, 12);
  header.writeUInt8(levels, 14);
  header.writeUInt8((transform & 0x0f) | (trajectoryComponents << 4), 15);
  header.writeFloatLE(options.maximumError, 16);
  header.writeUInt32LE(sampleCount, 20);
  header.writeUInt32LE(modelBytes.length, 24);
  header.writeUInt32LE(labelBytes.length, 28);
  header.writeUInt32LE(storedMask.length, 32);
  header.writeUInt32LE(storedExceptions.length, 36);
  header.writeUInt32LE(exceptionCount, 40);
  header.writeUInt32LE(sourceBits.byteLength, 44);
  const encoded = Buffer.concat([header, modelBytes, labelBytes, storedMask, storedExceptions]);
  return {
    encoded,
    decodedBits,
    metrics: {
      observationCount,
      dimensions,
      levels,
      transform: TRANSFORM_NAMES[transform],
      trajectoryComponents,
      maximumAllowedError: options.maximumError,
      measuredRmse: Math.sqrt(squareError / valueCount),
      measuredMaximumError: maximumError,
      preRepairRmse: Math.sqrt(preRepairSquareError / valueCount),
      preRepairMaximumError,
      preRepairThresholds: Object.fromEntries(preRepairThresholds.map((threshold, index) => [threshold, {
        count: preRepairThresholdCounts[index],
        ratio: preRepairThresholdCounts[index] / valueCount,
      }])),
      exceptionCount,
      exceptionRatio: exceptionCount / valueCount,
      sampleCount,
      sourceBytes: sourceBits.byteLength,
      modelBytes: modelBytes.length,
      labelBytes: labelBytes.length,
      exceptionMaskBytes: storedMask.length,
      exceptionValueBytes: storedExceptions.length,
      encodedBytes: encoded.length,
      compressionRatio: sourceBits.byteLength / encoded.length,
    },
  };
}

export function decodeMixRq(encoded) {
  if (encoded.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported MixRQ stream.');
  const observationCount = encoded.readUInt32LE(8);
  const dimensions = encoded.readUInt16LE(12);
  const levels = encoded.readUInt8(14);
  const transformFlags = encoded.readUInt8(15);
  const transform = transformFlags & 0x0f;
  const trajectoryComponents = transformFlags >>> 4;
  const maximumError = encoded.readFloatLE(16);
  const modelBytes = encoded.readUInt32LE(24);
  const labelBytes = encoded.readUInt32LE(28);
  const maskBytes = encoded.readUInt32LE(32);
  const exceptionBytes = encoded.readUInt32LE(36);
  const exceptionCount = encoded.readUInt32LE(40);
  const decodedBytes = encoded.readUInt32LE(44);
  if (!TRANSFORM_NAMES[transform]) throw new Error(`Unsupported MixRQ transform ${transform}.`);
  if (decodedBytes !== observationCount * dimensions * 2) throw new Error('Invalid MixRQ decoded byte count.');
  let offset = HEADER_BYTES;
  const model = deserializeModels(encoded.subarray(offset, offset + modelBytes), levels, dimensions);
  offset += modelBytes;
  const labels = deserializeLabels(encoded.subarray(offset, offset + labelBytes), levels, observationCount);
  offset += labelBytes;
  const mask = inflateSync(encoded.subarray(offset, offset + maskBytes));
  offset += maskBytes;
  const exceptions = inflateSync(encoded.subarray(offset, offset + exceptionBytes));
  offset += exceptionBytes;
  if (offset !== encoded.length || mask.length !== Math.ceil(observationCount * dimensions / 8)) throw new Error('Invalid MixRQ payload length.');
  const bits = reconstructBits(model.models, labels, observationCount, dimensions, transform, model.offsets, model.scales, trajectoryComponents);
  let exceptionOffset = 0;
  let appliedExceptions = 0;
  for (let observation = 0; observation < observationCount; observation += 1) {
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const flat = observation * dimensions + dimension;
      if ((mask[flat >>> 3] & (1 << (flat & 7))) === 0) continue;
      bits[flat] = exceptions[exceptionOffset] | (exceptions[exceptionOffset + 1] << 8);
      exceptionOffset += 2;
      appliedExceptions += 1;
    }
  }
  if (appliedExceptions !== exceptionCount || exceptionOffset !== exceptions.length) throw new Error('MixRQ exception count mismatch.');
  return {
    bits,
    metrics: {
      observationCount,
      dimensions,
      levels,
      transform: TRANSFORM_NAMES[transform],
      trajectoryComponents,
      maximumError,
      appliedExceptions,
    },
  };
}

// #WDD-gpt 2026-08-15 - MINT 码表按时间窗口独立训练和解码，避免六段属性分布互相污染，同时保留一个连续容器流。
export function packMixRqWindows(results) {
  const header = Buffer.alloc(12 + results.length * 4);
  header.write(WINDOW_MAGIC, 0, 'ascii');
  header.writeUInt16LE(results.length, 8);
  for (let index = 0; index < results.length; index += 1) header.writeUInt32LE(results[index].encoded.length, 12 + index * 4);
  return Buffer.concat([header, ...results.map((result) => result.encoded)]);
}

export function decodeMixRqWindows(encoded) {
  if (encoded.subarray(0, 8).toString('ascii') !== WINDOW_MAGIC) throw new Error('Unsupported windowed MixRQ stream.');
  const windowCount = encoded.readUInt16LE(8);
  let offset = 12 + windowCount * 4;
  const windows = [];
  for (let window = 0; window < windowCount; window += 1) {
    const bytes = encoded.readUInt32LE(12 + window * 4);
    windows.push(decodeMixRq(encoded.subarray(offset, offset + bytes)));
    offset += bytes;
  }
  if (offset !== encoded.length) throw new Error(`Unused windowed MixRQ bytes: ${encoded.length - offset}`);
  return windows;
}
