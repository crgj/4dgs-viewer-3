import { Buffer } from 'buffer';
import { unzlibSync, zlibSync } from 'fflate';
import { decodeScalarRq, encodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';

const MAGIC = 'OPHYB001';
const HEADER_BYTES = 32;

function orderedHalf(bits) {
  return bits & 0x8000 ? (~bits & 0xffff) : (bits ^ 0x8000);
}

function unorderedHalf(code) {
  return code & 0x8000 ? (code ^ 0x8000) : (~code & 0xffff);
}

function encodeResiduals(sourceBits, baseBits, observationCount) {
  const raw = Buffer.allocUnsafe(observationCount * 3 * 2);
  for (let observation = 0; observation < observationCount; observation += 1) {
    const sourceOffset = observation * 4;
    let previous = orderedHalf(baseBits[observation]);
    for (let dimension = 1; dimension < 4; dimension += 1) {
      const value = orderedHalf(sourceBits[sourceOffset + dimension]);
      const coded = (value - previous) & 0xffff;
      const plane = (dimension - 1) * observationCount * 2;
      raw[plane + observation] = coded & 0xff;
      raw[plane + observationCount + observation] = coded >>> 8;
      previous = value;
    }
  }
  return raw;
}

function reconstruct(baseBits, residuals, observationCount) {
  if (residuals.length !== observationCount * 3 * 2) throw new Error('Opacity hybrid residual length mismatch.');
  const bits = new Uint16Array(observationCount * 4);
  for (let observation = 0; observation < observationCount; observation += 1) {
    bits[observation * 4] = baseBits[observation];
    let previous = orderedHalf(baseBits[observation]);
    for (let dimension = 1; dimension < 4; dimension += 1) {
      const plane = (dimension - 1) * observationCount * 2;
      const coded = residuals[plane + observation] | (residuals[plane + observationCount + observation] << 8);
      const value = (previous + coded) & 0xffff;
      bits[observation * 4 + dimension] = unorderedHalf(value);
      previous = value;
    }
  }
  return bits;
}

// #WDD-gpt 2026-08-16 - V2.5 仅有界量化 Opacity 基值，三个时间 bank 以可逆 FP16 链式残差保存，避免快速运动累计重影。
export function encodeOpacityHybrid(sourceBits, observationCount, options = {}) {
  if (sourceBits.length !== observationCount * 4) throw new Error('Opacity hybrid expects four banks per observation.');
  const bank0 = new Uint16Array(observationCount);
  for (let observation = 0; observation < observationCount; observation += 1) bank0[observation] = sourceBits[observation * 4];
  const baseExact = Boolean(options.baseExact);
  let baseEncoded;
  let decodedBaseBits;
  let baseMetrics;
  if (baseExact) {
    baseEncoded = Buffer.allocUnsafe(observationCount * 2);
    for (let observation = 0; observation < observationCount; observation += 1) {
      baseEncoded[observation] = bank0[observation] & 0xff;
      baseEncoded[observationCount + observation] = bank0[observation] >>> 8;
    }
    decodedBaseBits = bank0;
    baseMetrics = { observationCount, dimensions: 1, codec: 'exact-fp16-byte-plane', measuredRmse: 0, measuredMaximumError: 0, encodedBytes: baseEncoded.length };
  } else {
    const base = encodeScalarRq(bank0, observationCount, 1, {
      bitsByDimension: [options.baseBits ?? 8],
      predictors: [-1],
      transform: 'opacityAlpha',
      maximumError: options.baseMaximumAlphaError ?? 0.003,
      sampleCount: options.sampleCount ?? 32768,
    });
    baseEncoded = base.encoded;
    decodedBaseBits = base.decodedBits;
    baseMetrics = base.metrics;
  }
  const rawResiduals = encodeResiduals(sourceBits, decodedBaseBits, observationCount);
  const residualCompression = options.residualCompression ?? 'zlib';
  if (!['zlib', 'none'].includes(residualCompression)) throw new Error(`Unsupported Opacity hybrid residual compression ${residualCompression}.`);
  const storedResiduals = residualCompression === 'zlib' ? zlibSync(rawResiduals, { level: 9 }) : rawResiduals;
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(observationCount, 8);
  header.writeUInt16LE(4, 12);
  header.writeUInt8(residualCompression === 'zlib' ? 1 : 2, 14);
  header.writeUInt8(baseExact ? 2 : 1, 15);
  header.writeUInt32LE(baseEncoded.length, 16);
  header.writeUInt32LE(storedResiduals.length, 20);
  header.writeUInt32LE(rawResiduals.length, 24);
  header.writeUInt32LE(0, 28);
  const encoded = Buffer.concat([header, baseEncoded, storedResiduals]);
  return {
    encoded,
    decodedBits: reconstruct(decodedBaseBits, rawResiduals, observationCount),
    metrics: {
      observationCount,
      dimensions: 4,
      base: baseMetrics,
      exactTemporalDimensions: [1, 2, 3],
      residualTransform: `ordered-fp16-chain-delta-byte-plane-${residualCompression}`,
      residualCompression,
      residualRawBytes: rawResiduals.length,
      residualStoredBytes: storedResiduals.length,
      encodedBytes: encoded.length,
    },
  };
}

export function decodeOpacityHybrid(encoded) {
  if (encoded.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported Opacity hybrid stream.');
  const observationCount = encoded.readUInt32LE(8);
  const dimensions = encoded.readUInt16LE(12);
  const codec = encoded.readUInt8(14);
  const baseCodec = encoded.readUInt8(15);
  const baseBytes = encoded.readUInt32LE(16);
  const residualBytes = encoded.readUInt32LE(20);
  const residualRawBytes = encoded.readUInt32LE(24);
  if (dimensions !== 4 || ![1, 2].includes(codec) || ![1, 2].includes(baseCodec) || HEADER_BYTES + baseBytes + residualBytes !== encoded.length) {
    throw new Error('Invalid Opacity hybrid metadata.');
  }
  let baseBits;
  let baseMetrics;
  if (baseCodec === 2) {
    if (baseBytes !== observationCount * 2) throw new Error('Opacity hybrid exact base length mismatch.');
    baseBits = new Uint16Array(observationCount);
    for (let observation = 0; observation < observationCount; observation += 1) {
      baseBits[observation] = encoded[HEADER_BYTES + observation] | (encoded[HEADER_BYTES + observationCount + observation] << 8);
    }
    baseMetrics = { observationCount, dimensions: 1, codec: 'exact-fp16-byte-plane', measuredRmse: 0, measuredMaximumError: 0, encodedBytes: baseBytes };
  } else {
    const base = decodeScalarRq(encoded.subarray(HEADER_BYTES, HEADER_BYTES + baseBytes));
    if (base.metrics.observationCount !== observationCount || base.metrics.dimensions !== 1) throw new Error('Opacity hybrid base layout mismatch.');
    baseBits = base.bits;
    baseMetrics = base.metrics;
  }
  const storedResiduals = encoded.subarray(HEADER_BYTES + baseBytes);
  const residuals = codec === 1 ? unzlibSync(storedResiduals) : storedResiduals;
  if (residuals.length !== residualRawBytes) throw new Error('Opacity hybrid residual payload mismatch.');
  return {
    bits: reconstruct(baseBits, residuals, observationCount),
    metrics: {
      observationCount,
      dimensions,
      base: baseMetrics,
      exactTemporalDimensions: [1, 2, 3],
      residualTransform: `ordered-fp16-chain-delta-byte-plane-${codec === 1 ? 'zlib' : 'none'}`,
      residualCompression: codec === 1 ? 'zlib' : 'none',
      residualRawBytes,
      residualStoredBytes: residualBytes,
      encodedBytes: encoded.length,
    },
  };
}
