import { deflateSync, inflateSync } from 'node:zlib';
import { floatToHalf, halfToFloat } from './fourcgs-prs-codec.mjs';
import { decodeScalarRq, encodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';

const MAGIC = 'TMRQ0001';
const HEADER_BYTES = 48;
const DOMAINS = { identity: 0, opacityAlpha: 1 };
const DOMAIN_NAMES = ['identity', 'opacityAlpha'];

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function logit(value) {
  const bounded = Math.max(1e-6, Math.min(1 - 1e-6, value));
  return Math.log(bounded / (1 - bounded));
}

function toDomain(bits, domain) {
  const value = halfToFloat(bits);
  return domain === DOMAINS.opacityAlpha ? sigmoid(value) : value;
}

function fromDomain(value, domain) {
  return floatToHalf(domain === DOMAINS.opacityAlpha ? logit(value) : value);
}

function slotCount(activeSlots) {
  let maximum = -1;
  for (const slots of activeSlots) {
    for (const slot of slots) maximum = Math.max(maximum, slot);
  }
  return maximum + 1;
}

function observationCount(activeSlots) {
  return activeSlots.reduce((sum, slots) => sum + slots.length, 0);
}

function temporalTransform(sourceBits, activeSlots, bankCount, components, domain) {
  const dimensions = bankCount * components;
  const transformed = new Uint16Array(sourceBits.length);
  const state = new Float32Array(slotCount(activeSlots) * components);
  const initialized = new Uint8Array(state.length / components);
  let observation = 0;
  for (const slots of activeSlots) {
    for (const slot of slots) {
      const offset = observation * dimensions;
      for (let component = 0; component < components; component += 1) {
        const base = toDomain(sourceBits[offset + component], domain);
        const last = toDomain(sourceBits[offset + (bankCount - 1) * components + component], domain);
        const previous = initialized[slot] ? state[slot * components + component] : 0;
        transformed[offset + component] = floatToHalf(base - previous);
        for (let bank = 1; bank < bankCount - 1; bank += 1) {
          const source = toDomain(sourceBits[offset + bank * components + component], domain);
          const amount = bank / (bankCount - 1);
          transformed[offset + bank * components + component] = floatToHalf(source - ((1 - amount) * base + amount * last));
        }
        transformed[offset + (bankCount - 1) * components + component] = floatToHalf(last - base);
        state[slot * components + component] = last;
      }
      initialized[slot] = 1;
      observation += 1;
    }
  }
  return transformed;
}

function reconstruct(transformedBits, activeSlots, bankCount, components, domain, repair) {
  const dimensions = bankCount * components;
  const decodedBits = new Uint16Array(transformedBits.length);
  const state = new Float32Array(slotCount(activeSlots) * components);
  const initialized = new Uint8Array(state.length / components);
  let observation = 0;
  let squaredError = 0;
  let maximumError = 0;
  let preRepairSquaredError = 0;
  let preRepairMaximumError = 0;
  let exceptionOffset = 0;
  let exceptionCount = 0;
  for (const slots of activeSlots) {
    for (const slot of slots) {
      const offset = observation * dimensions;
      const values = new Float32Array(dimensions);
      for (let component = 0; component < components; component += 1) {
        const previous = initialized[slot] ? state[slot * components + component] : 0;
        const base = previous + halfToFloat(transformedBits[offset + component]);
        const last = base + halfToFloat(transformedBits[offset + (bankCount - 1) * components + component]);
        values[component] = base;
        values[(bankCount - 1) * components + component] = last;
        for (let bank = 1; bank < bankCount - 1; bank += 1) {
          const amount = bank / (bankCount - 1);
          values[bank * components + component] = (1 - amount) * base + amount * last
            + halfToFloat(transformedBits[offset + bank * components + component]);
        }
      }
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        const flat = offset + dimension;
        let bits = fromDomain(values[dimension], domain);
        if (repair?.sourceBits) {
          const source = toDomain(repair.sourceBits[flat], domain);
          const error = Math.abs(source - toDomain(bits, domain));
          preRepairSquaredError += error * error;
          preRepairMaximumError = Math.max(preRepairMaximumError, error);
          if (!Number.isFinite(error) || error > repair.maximumError) {
            repair.mask[flat >>> 3] |= 1 << (flat & 7);
            repair.exceptions.push(repair.sourceBits[flat] & 0xff, repair.sourceBits[flat] >>> 8);
            bits = repair.sourceBits[flat];
            exceptionCount += 1;
          }
          const repairedError = Math.abs(source - toDomain(bits, domain));
          squaredError += repairedError * repairedError;
          maximumError = Math.max(maximumError, repairedError);
        } else if (repair?.mask && (repair.mask[flat >>> 3] & (1 << (flat & 7))) !== 0) {
          if (exceptionOffset + 2 > repair.exceptions.length) throw new Error('Truncated temporal RQ exception values.');
          bits = repair.exceptions[exceptionOffset] | (repair.exceptions[exceptionOffset + 1] << 8);
          exceptionOffset += 2;
          exceptionCount += 1;
        }
        decodedBits[flat] = bits;
      }
      for (let component = 0; component < components; component += 1) {
        state[slot * components + component] = toDomain(
          decodedBits[offset + (bankCount - 1) * components + component],
          domain,
        );
      }
      initialized[slot] = 1;
      observation += 1;
    }
  }
  if (repair?.mask && !repair.sourceBits && exceptionOffset !== repair.exceptions.length) {
    throw new Error('Unused temporal RQ exception values.');
  }
  return {
    decodedBits,
    metrics: {
      observationCount: observation,
      valueCount: transformedBits.length,
      measuredRmse: repair?.sourceBits ? Math.sqrt(squaredError / transformedBits.length) : undefined,
      measuredMaximumError: repair?.sourceBits ? maximumError : undefined,
      preRepairRmse: repair?.sourceBits ? Math.sqrt(preRepairSquaredError / transformedBits.length) : undefined,
      preRepairMaximumError: repair?.sourceBits ? preRepairMaximumError : undefined,
      exceptionCount,
    },
  };
}

// #WDD-gpt 2026-08-15 - 将六段同一 Track 的首关键帧预测为上一段末帧，并把段内中间关键帧改写成端点线性预测残差。
export function encodeTemporalRq(sourceBits, activeSlots, bankCount, components, options) {
  const count = observationCount(activeSlots);
  const dimensions = bankCount * components;
  if (sourceBits.length !== count * dimensions) throw new Error('Temporal RQ source dimensions do not match active tracks.');
  const domain = DOMAINS[options.domain ?? 'identity'];
  if (domain === undefined) throw new Error(`Unsupported temporal RQ domain ${options.domain}.`);
  const transformedBits = temporalTransform(sourceBits, activeSlots, bankCount, components, domain);
  const scalar = encodeScalarRq(transformedBits, count, dimensions, {
    bitsByDimension: options.bitsByDimension,
    predictors: Array(dimensions).fill(-1),
    transform: 'identity',
    maximumError: options.residualMaximumError ?? options.maximumError,
    sampleCount: options.sampleCount ?? 32768,
  });
  const mask = new Uint8Array(Math.ceil(sourceBits.length / 8));
  const exceptions = [];
  const reconstructed = reconstruct(scalar.decodedBits, activeSlots, bankCount, components, domain, {
    sourceBits,
    maximumError: options.maximumError,
    mask,
    exceptions,
  });
  const storedMask = deflateSync(mask, { level: 9 });
  const storedExceptions = deflateSync(Buffer.from(exceptions), { level: 9 });
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(count, 8);
  header.writeUInt16LE(dimensions, 12);
  header.writeUInt8(bankCount, 14);
  header.writeUInt8(components, 15);
  header.writeUInt8(domain, 16);
  header.writeUInt8(0, 17);
  header.writeUInt16LE(activeSlots.length, 18);
  header.writeFloatLE(options.maximumError, 20);
  header.writeUInt32LE(scalar.encoded.length, 24);
  header.writeUInt32LE(storedMask.length, 28);
  header.writeUInt32LE(storedExceptions.length, 32);
  header.writeUInt32LE(reconstructed.metrics.exceptionCount, 36);
  header.writeUInt32LE(sourceBits.byteLength, 40);
  header.writeUInt32LE(transformedBits.byteLength, 44);
  const encoded = Buffer.concat([header, scalar.encoded, storedMask, storedExceptions]);
  return {
    encoded,
    decodedBits: reconstructed.decodedBits,
    metrics: {
      ...reconstructed.metrics,
      domain: DOMAIN_NAMES[domain],
      bankCount,
      components,
      maximumAllowedError: options.maximumError,
      temporalTransform: 'cross-segment previous endpoint + within-segment linear endpoint residual',
      bitsByDimension: options.bitsByDimension,
      sourceBytes: sourceBits.byteLength,
      transformedBytes: transformedBits.byteLength,
      encodedBytes: encoded.length,
      compressionRatio: sourceBits.byteLength / encoded.length,
      exceptionMaskBytes: storedMask.length,
      exceptionValueBytes: storedExceptions.length,
      scalarRq: scalar.metrics,
    },
  };
}

export function decodeTemporalRq(encoded, activeSlots) {
  if (encoded.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported temporal RQ stream.');
  const count = encoded.readUInt32LE(8);
  const dimensions = encoded.readUInt16LE(12);
  const bankCount = encoded.readUInt8(14);
  const components = encoded.readUInt8(15);
  const domain = encoded.readUInt8(16);
  const segmentCount = encoded.readUInt16LE(18);
  const maximumError = encoded.readFloatLE(20);
  const scalarBytes = encoded.readUInt32LE(24);
  const maskBytes = encoded.readUInt32LE(28);
  const exceptionBytes = encoded.readUInt32LE(32);
  const expectedExceptions = encoded.readUInt32LE(36);
  const sourceBytes = encoded.readUInt32LE(40);
  const transformedBytes = encoded.readUInt32LE(44);
  if (segmentCount !== activeSlots.length || count !== observationCount(activeSlots) || dimensions !== bankCount * components) {
    throw new Error('Temporal RQ layout mismatch.');
  }
  if (!DOMAIN_NAMES[domain] || sourceBytes !== count * dimensions * 2 || transformedBytes !== sourceBytes) {
    throw new Error('Invalid temporal RQ metadata.');
  }
  let offset = HEADER_BYTES;
  const scalar = decodeScalarRq(encoded.subarray(offset, offset + scalarBytes));
  offset += scalarBytes;
  const mask = inflateSync(encoded.subarray(offset, offset + maskBytes));
  offset += maskBytes;
  const exceptions = inflateSync(encoded.subarray(offset, offset + exceptionBytes));
  offset += exceptionBytes;
  if (offset !== encoded.length || mask.length !== Math.ceil(count * dimensions / 8) || exceptions.length !== expectedExceptions * 2) {
    throw new Error('Invalid temporal RQ payload bytes.');
  }
  const reconstructed = reconstruct(scalar.bits, activeSlots, bankCount, components, domain, { mask, exceptions });
  if (reconstructed.metrics.exceptionCount !== expectedExceptions) throw new Error('Temporal RQ exception count mismatch.');
  return {
    bits: reconstructed.decodedBits,
    metrics: {
      observationCount: count,
      dimensions,
      bankCount,
      components,
      domain: DOMAIN_NAMES[domain],
      maximumError,
      appliedExceptions: expectedExceptions,
      scalarRq: scalar.metrics,
    },
  };
}
