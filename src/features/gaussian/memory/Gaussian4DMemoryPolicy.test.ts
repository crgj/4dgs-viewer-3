import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAUSSIAN_4D_MEMORY_MODE,
  createAutomaticGaussian4DMemoryPolicy,
  createGaussian4DMemoryPolicy,
} from './Gaussian4DMemoryPolicy';

describe('4D Gaussian memory policy', () => {
  it('starts in the local workstation maximum preset', () => {
    expect(DEFAULT_GAUSSIAN_4D_MEMORY_MODE).toBe('local-maximum');
    const policy = createGaussian4DMemoryPolicy(DEFAULT_GAUSSIAN_4D_MEMORY_MODE);
    expect(policy.cpuBudgetBytes).toBe(32 * 1024 ** 3);
    expect(policy.gpuBudgetBytes).toBe(12 * 1024 ** 3);
  });

  it('uses the highest browser-reported CPU capacity and the maximum automatic GPU budget', () => {
    const policy = createAutomaticGaussian4DMemoryPolicy(24, 4 * 1024 ** 3);
    expect(policy.mode).toBe('auto');
    expect(policy.cpuBudgetBytes).toBe(24 * 1024 ** 3);
    expect(policy.gpuBudgetBytes).toBe(8 * 1024 ** 3);
  });

  it('uses a high-memory fallback when the browser reports no capacity', () => {
    const policy = createAutomaticGaussian4DMemoryPolicy();
    expect(policy.cpuBudgetBytes).toBe(8 * 1024 ** 3);
  });

  it('clamps custom CPU and GPU budgets', () => {
    const policy = createGaussian4DMemoryPolicy('custom', 100, 0.1);
    expect(policy.cpuBudgetBytes).toBe(64 * 1024 ** 3);
    expect(policy.gpuBudgetBytes).toBe(0.5 * 1024 ** 3);
  });

  it('provides an explicit local maximum workstation preset', () => {
    const policy = createGaussian4DMemoryPolicy('local-maximum');
    expect(policy.cpuBudgetBytes).toBe(32 * 1024 ** 3);
    expect(policy.gpuBudgetBytes).toBe(12 * 1024 ** 3);
    expect(policy.preloadAllKeyframes).toBe(true);
  });

  it('provides a bounded mobile preset without future-segment preloading', () => {
    const policy = createGaussian4DMemoryPolicy('mobile');
    expect(policy.cpuBudgetBytes).toBe(768 * 1024 ** 2);
    expect(policy.gpuBudgetBytes).toBe(192 * 1024 ** 2);
    expect(policy.gpuChunkBytes).toBe(16 * 1024 ** 2);
    expect(policy.preloadAllKeyframes).toBe(false);
  });
});
