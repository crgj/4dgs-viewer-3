import { describe, expect, it } from 'vitest';
import { reconcileRelightingWorkflowStep } from './RelightingWorkflowPanel';

describe('RelightingWorkflowPanel', () => {
  it('advances to Step 2 only when a new mesh becomes ready', () => {
    expect(reconcileRelightingWorkflowStep('mesh', 'installing', 'success')).toBe('lighting');
    expect(reconcileRelightingWorkflowStep('mesh', 'success', 'success')).toBe('mesh');
  });

  it('returns to Step 1 when the mesh is cleared or rebuilt', () => {
    expect(reconcileRelightingWorkflowStep('lighting', 'success', 'idle')).toBe('mesh');
    expect(reconcileRelightingWorkflowStep('lighting', 'success', 'capturing')).toBe('mesh');
  });
});
