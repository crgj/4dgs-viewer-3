import { describe, expect, it } from 'vitest';
import { createGaussian4DMemoryPolicy } from '../../gaussian/memory/Gaussian4DMemoryPolicy';
import { isRuntimeMemoryPolicyApplied, remainingMemoryBytes } from './MemoryTelemetryModel';

describe('memory telemetry model', () => {
  it('requires runtime mode and both budgets to match before reporting active', () => {
    const policy = createGaussian4DMemoryPolicy('local-maximum');
    expect(isRuntimeMemoryPolicyApplied({
      runtimePolicyMode: 'local-maximum',
      cpuBudgetBytes: policy.cpuBudgetBytes,
      gpuBudgetBytes: policy.gpuBudgetBytes,
    }, policy)).toBe(true);
    expect(isRuntimeMemoryPolicyApplied({
      runtimePolicyMode: 'auto',
      cpuBudgetBytes: policy.cpuBudgetBytes,
      gpuBudgetBytes: policy.gpuBudgetBytes,
    }, policy)).toBe(false);
  });

  it('reports non-negative remaining capacity without inventing unavailable values', () => {
    expect(remainingMemoryBytes(40, 100)).toBe(60);
    expect(remainingMemoryBytes(120, 100)).toBe(0);
    expect(remainingMemoryBytes(null, 100)).toBeNull();
  });
});
