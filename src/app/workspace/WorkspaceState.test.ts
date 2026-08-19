import { describe, expect, it } from 'vitest';
import { workspaceSourceIdentities, workspaceSourcesMatch } from './WorkspaceState';

describe('WorkspaceState source identity', () => {
  it('only restores state to the exact ordered source set', () => {
    const files = [
      new File(['abc'], 'segment_0_2.raw4d', { lastModified: 10 }),
      new File(['defg'], 'segment_2_4.raw4d', { lastModified: 20 }),
    ];
    const identity = workspaceSourceIdentities(files);
    expect(workspaceSourcesMatch(identity, files)).toBe(true);
    expect(workspaceSourcesMatch(identity, [...files].reverse())).toBe(false);
    expect(workspaceSourcesMatch(identity, [new File(['abc'], files[0].name, { lastModified: 11 }), files[1]])).toBe(false);
  });
});
