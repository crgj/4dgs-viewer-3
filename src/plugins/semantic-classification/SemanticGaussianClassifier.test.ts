import { describe, expect, it } from 'vitest';
import { classifyProjectedGaussians } from './SemanticGaussianClassifier';
import type { SemanticViewMask } from './SemanticClassificationTypes';

const tags = [
  { id: 1, name: '人物', prompt: 'person', color: '#55aaff' },
  { id: 2, name: '地面', prompt: 'ground', color: '#55dd99' },
];

function view(id: string, probabilities: number[], width = 1, frame = 0): SemanticViewMask {
  return {
    id,
    frame,
    center: [0, 0, 0],
    right: [1, 0, 0],
    up: [0, 1, 0],
    forward: [0, 0, 1],
    horizontalSpan: 2,
    verticalSpan: 2,
    width,
    height: 1,
    probabilities: new Float32Array(probabilities),
  };
}

describe('classifyProjectedGaussians', () => {
  it('uses the threshold to accept reliable direct seeds', () => {
    const result = classifyProjectedGaussians({
      positions: new Float32Array([0, 0, 0, 0.5, 0, 0]),
      opacities: new Float32Array([1, 1]),
      deletedWords: new Uint32Array(1),
      tags,
      views: [view('a', [0.9, 0.2]), view('b', [0.42, 0.39])],
      threshold: 0.6,
      occlusionTolerance: 1,
    });
    expect(Array.from(result.classIds)).toEqual([1, 1]);
    expect(result.activePointCount).toBe(2);
    expect(result.classifiedCount).toBe(2);
    expect(result.directCount).toBe(2);
    expect(result.propagatedCount).toBe(0);
  });

  it('classifies single-view points but excludes deleted points from coverage', () => {
    const result = classifyProjectedGaussians({
      positions: new Float32Array([0, 0, 0, 0, 0, 0]),
      opacities: new Float32Array([1, 1]),
      deletedWords: new Uint32Array([1]),
      tags: [tags[0]],
      views: [view('one', [0.99])],
      threshold: 0.5,
      occlusionTolerance: 1,
    });
    expect(Array.from(result.classIds)).toEqual([0, 1]);
    expect(result.deletedPointCount).toBe(1);
    expect(result.activePointCount).toBe(1);
    expect(result.classifiedCount).toBe(1);
  });

  it('propagates reliable local labels to active occluded points without letting a remote class swallow them', () => {
    const positions = new Float32Array([
      -0.75, 0, 0, -0.75, 0, 0.05,
      0.75, 0, 0, 0.75, 0, 0.05,
    ]);
    const opacities = new Float32Array([1, 1, 1, 1]);
    const probabilities = [
      0.95, 0.95, 0.1, 0.1,
      0.08, 0.08, 0.92, 0.92,
    ];
    const result = classifyProjectedGaussians({
      positions,
      opacities,
      deletedWords: new Uint32Array(1),
      tags,
      views: [view('front', probabilities, 4), view('back', probabilities, 4)],
      threshold: 0.6,
      occlusionTolerance: 0.01,
    });
    expect(Array.from(result.classIds)).toEqual([1, 1, 2, 2]);
    expect(result.classifiedCount).toBe(4);
    expect(result.directCount).toBe(2);
    expect(result.propagatedCount).toBe(2);
    expect(result.classes.map((item) => item.count)).toEqual([2, 2]);
  });

  it('leaves points without safe temporal or visual evidence unclassified', () => {
    const result = classifyProjectedGaussians({
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      opacities: new Float32Array([Number.NEGATIVE_INFINITY, 0]),
      deletedWords: new Uint32Array(1),
      tags,
      views: [view('front', [0.5, 0.5]), view('back', [0.5, 0.5])],
      threshold: 0.6,
      occlusionTolerance: 0.01,
    });
    expect(Array.from(result.classIds)).toEqual([0, 0]);
    expect(result.classifiedCount).toBe(0);
    expect(result.confidences.every((value) => value === 0)).toBe(true);
  });

  it('does not propagate a global majority when no reliable seed exists', () => {
    const result = classifyProjectedGaussians({
      positions: new Float32Array([-0.5, 0, 1, 0.5, 0, 1]),
      opacities: new Float32Array([1, 1]),
      deletedWords: new Uint32Array(1),
      tags,
      views: [
        view('front-a', [0.44, 0.42, 0.44, 0.42], 2),
        view('front-b', [0.44, 0.42, 0.44, 0.42], 2),
      ],
      threshold: 0.6,
      occlusionTolerance: 0.01,
    });
    expect(Array.from(result.classIds)).toEqual([0, 0]);
    expect(result.directCount).toBe(0);
    expect(result.propagatedCount).toBe(0);
    expect(result.classifiedCount).toBe(0);
  });

  it('calibrates each CLIPSeg prompt before comparing independent binary probabilities', () => {
    const width = 128;
    const person = new Array<number>(width).fill(0.2);
    const ground = new Array<number>(width).fill(0.45);
    person.fill(0.42, 0, 4);
    ground.fill(0.7, width - 4);
    const probabilities = [...person, ...ground];
    const result = classifyProjectedGaussians({
      positions: new Float32Array([-0.99, 0, 1, 0.99, 0, 1]),
      opacities: new Float32Array([1, 1]),
      deletedWords: new Uint32Array(1),
      tags,
      views: [view('calibrated-a', probabilities, width), view('calibrated-b', probabilities, width)],
      threshold: 0.6,
      occlusionTolerance: 0.01,
    });
    expect(Array.from(result.classIds)).toEqual([1, 2]);
    expect(result.directCount).toBe(2);
  });

  it('uses the position and opacity of each temporal capture instead of one current frame', () => {
    const result = classifyProjectedGaussians({
      positions: new Float32Array([-0.5, 0, 1, 0.5, 0, 1]),
      opacities: new Float32Array([1, 0]),
      frames: [
        { frame: 0, positions: new Float32Array([-0.5, 0, 1, 0.5, 0, 1]), opacities: new Float32Array([1, 0]) },
        { frame: 1, positions: new Float32Array([-0.5, 0, 1, 0.5, 0, 1]), opacities: new Float32Array([0, 1]) },
      ],
      deletedWords: new Uint32Array(1),
      tags,
      views: [
        view('frame-0', [0.9, 0.1, 0.1, 0.9], 2, 0),
        view('frame-0-b', [0.9, 0.1, 0.1, 0.9], 2, 0),
        view('frame-1', [0.9, 0.1, 0.1, 0.9], 2, 1),
        view('frame-1-b', [0.9, 0.1, 0.1, 0.9], 2, 1),
      ],
      threshold: 0.6,
      occlusionTolerance: 0.01,
    });
    expect(Array.from(result.classIds)).toEqual([1, 2]);
    expect(result.classifiedCount).toBe(2);
    expect(result.directCount).toBe(2);
    expect(result.propagatedCount).toBe(0);
  });
});
