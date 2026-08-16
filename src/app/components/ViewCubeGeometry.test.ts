import { describe, expect, it } from 'vitest';
import {
  activeViewCubeFace,
  pickViewCubeFace,
  projectViewCubeFaces,
} from './ViewCubeGeometry';

describe('ViewCubeGeometry', () => {
  it.each([
    [0, 0, 'front'],
    [180, 0, 'back'],
    [-90, 0, 'left'],
    [90, 0, 'right'],
    [0, 90, 'top'],
    [0, -90, 'bottom'],
  ] as const)('projects %s/%s as the active %s face', (yaw, pitch, expected) => {
    const faces = projectViewCubeFaces(64, 64, yaw, pitch);
    expect(faces.map((face) => face.id)).toEqual([expected]);
    expect(activeViewCubeFace(faces)).toBe(expected);
    expect(pickViewCubeFace(faces, 32, 32)).toBe(expected);
  });

  it('exposes three depth-sorted faces from an oblique camera', () => {
    const faces = projectViewCubeFaces(64, 64, 38, -24);
    expect(new Set(faces.map((face) => face.id))).toEqual(new Set(['front', 'right', 'bottom']));
    expect(faces.every((face, index) => index === 0 || faces[index - 1].depth <= face.depth)).toBe(true);
    expect(activeViewCubeFace(faces)).toBeNull();
  });

  it('does not pick outside the projected cube', () => {
    const faces = projectViewCubeFaces(64, 64, 35, 25);
    expect(pickViewCubeFace(faces, 1, 1)).toBeNull();
  });
});
