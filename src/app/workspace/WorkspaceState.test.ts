import { describe, expect, it } from 'vitest';
import {
  FORCE_SORT_SYNC_REVISION,
  restoreWorkspaceForceSortSync,
  workspaceSourceIdentities,
  workspaceSourcesMatch,
} from './WorkspaceState';

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

describe('WorkspaceState frame sort migration', () => {
  it('enables correct per-frame sorting for legacy drafts, including their old persisted false default', () => {
    expect(restoreWorkspaceForceSortSync({})).toBe(true);
    expect(restoreWorkspaceForceSortSync({ forceSortSync: false })).toBe(true);
  });

  it('preserves an explicit user choice after the correctness-first revision is recorded', () => {
    expect(restoreWorkspaceForceSortSync({
      forceSortSync: false,
      forceSortSyncRevision: FORCE_SORT_SYNC_REVISION,
    })).toBe(false);
    expect(restoreWorkspaceForceSortSync({
      forceSortSync: true,
      forceSortSyncRevision: FORCE_SORT_SYNC_REVISION,
    })).toBe(true);
  });
});
