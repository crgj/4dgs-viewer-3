import { describe, expect, it } from 'vitest';
import {
  decodeSo3Rotations,
  encodeSo3Rotations,
} from '../../../../../scripts/fourcgs-so3-temporal-codec.mjs';
import {
  decodeOpacityHybrid,
  encodeOpacityHybrid,
} from '../../../../../scripts/fourcgs-opacity-hybrid-codec.mjs';
import { floatToHalf, halfToFloat } from '../../../../../scripts/fourcgs-prs-codec.mjs';

function rotationRoundTrip(bankCount: number): void {
  const propertyNames = Array.from({ length: bankCount }, (_, bank) => (
    ['w', 'x', 'y', 'z'].map((component) => `rot_bank_${bank}_${component}`)
  )).flat();
  const propertyIndex = new Map(propertyNames.map((name, index) => [name, index]));
  const rows = new Uint16Array(2 * propertyNames.length);
  for (let row = 0; row < 2; row += 1) {
    for (let bank = 0; bank < bankCount; bank += 1) {
      const angle = (row * 0.04 + bank * 0.03);
      const quaternion = [Math.cos(angle / 2), 0, Math.sin(angle / 2), 0];
      for (let component = 0; component < 4; component += 1) {
        rows[row * propertyNames.length + bank * 4 + component] = floatToHalf(quaternion[component]);
      }
    }
  }
  const segment = { count: 2, propertyNames, propertyIndex, rows };
  const layout = {
    slotCount: 2,
    activeSlots: [new Int32Array([0, 1])],
    slotToLocal: [new Int32Array([0, 1])],
  };
  const encoded = encodeSo3Rotations([segment], layout, [bankCount], {
    bits: 12,
    stepDegrees: 0.05,
    maximumAngleDegrees: 0.1,
  });
  const decodedRows = [new Uint16Array(rows.length)];
  const manifest = {
    slotCount: 2,
    segments: [{ bankCounts: { rotation: bankCount } }],
  };
  decodeSo3Rotations(encoded.encoded, manifest, layout.activeSlots, decodedRows, [propertyIndex]);
  for (let row = 0; row < 2; row += 1) {
    for (let bank = 0; bank < bankCount; bank += 1) {
      const source = Array.from({ length: 4 }, (_, component) => halfToFloat(rows[row * propertyNames.length + bank * 4 + component]));
      const decoded = Array.from({ length: 4 }, (_, component) => halfToFloat(decodedRows[0][row * propertyNames.length + bank * 4 + component]));
      const sourceLength = Math.hypot(...source);
      const decodedLength = Math.hypot(...decoded);
      const dot = Math.abs(source.reduce((sum, value, component) => sum + value / sourceLength * decoded[component] / decodedLength, 0));
      const errorDegrees = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
      expect(errorDegrees).toBeLessThanOrEqual(0.1001);
    }
  }
}

describe('adaptive 4CGS variable bank codecs', () => {
  it('round-trips one, two and three Rotation banks within the hard angular gate', () => {
    for (const bankCount of [1, 2, 3]) rotationRoundTrip(bankCount);
  });

  it('keeps every declared Opacity bank bit-exact', () => {
    for (const bankCount of [1, 4, 6]) {
      const observations = 7;
      const source = new Uint16Array(observations * bankCount);
      for (let index = 0; index < source.length; index += 1) source[index] = floatToHalf((index % 9 - 4) * 0.125);
      const encoded = encodeOpacityHybrid(source, observations, { baseExact: true });
      const decoded = decodeOpacityHybrid(encoded.encoded);
      expect(decoded.metrics.dimensions).toBe(bankCount);
      expect(decoded.bits).toEqual(source);
    }
  });
});
