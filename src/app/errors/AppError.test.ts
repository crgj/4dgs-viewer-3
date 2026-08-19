import { describe, expect, it } from 'vitest';
import { describeAppError } from './AppError';

describe('describeAppError', () => {
  it('maps worker termination to a safe recovery message', () => {
    const result = describeAppError(new Error('RAW4D loader worker stopped unexpectedly.'), 'zh');
    expect(result.title).toBe('后台处理已中断');
    expect(result.details).toContain('RAW4D loader worker');
  });

  it('keeps raw details out of the user-facing summary', () => {
    const result = describeAppError(new Error('opaque low level failure'), 'en');
    expect(result.summary).not.toContain('opaque low level failure');
    expect(result.details).toBe('opaque low level failure');
  });
});
