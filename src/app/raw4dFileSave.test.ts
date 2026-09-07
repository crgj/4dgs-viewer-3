import { describe, expect, it, vi } from 'vitest';
import {
  createRaw4DSavePickerOptions,
  RAW4D_SEGMENTS_DIRECTORY_PICKER_OPTIONS,
  raw4DExportFilename,
  uniqueRaw4DExportFilenames,
  writeRaw4DBlobToDirectory,
} from './raw4dFileSave';

describe('RAW4D file save helpers', () => {
  it('configures one-file and multi-segment browser pickers', () => {
    expect(createRaw4DSavePickerOptions('segment_0_30.raw4d')).toMatchObject({
      id: 'dong-editor-3-raw4d-export',
      suggestedName: 'segment_0_30.raw4d',
      startIn: 'downloads',
    });
    expect(RAW4D_SEGMENTS_DIRECTORY_PICKER_OPTIONS).toEqual({
      id: 'dong-editor-3-raw4d-segments-v1',
      mode: 'readwrite',
      startIn: 'downloads',
    });
  });

  it('normalizes extensions and de-duplicates names case-insensitively', () => {
    expect(raw4DExportFilename('take.ply4')).toBe('take.raw4d');
    expect(raw4DExportFilename('../unsafe:take.raw4d')).toBe('unsafe_take.raw4d');
    expect(uniqueRaw4DExportFilenames(['take.raw4d', 'TAKE.ply4', '', ''])).toEqual([
      'take.raw4d', 'TAKE-2.raw4d', 'segment-3.raw4d', 'segment-4.raw4d',
    ]);
  });

  it('writes and closes one segment in the selected directory', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const getFileHandle = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close, abort }),
    });
    const blob = new Blob(['raw4d']);

    await writeRaw4DBlobToDirectory({ getFileHandle } as unknown as FileSystemDirectoryHandle, 'part.raw4d', blob);

    expect(getFileHandle).toHaveBeenCalledWith('part.raw4d', { create: true });
    expect(write).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });

  it('aborts a partial directory file when its write fails', async () => {
    const failure = new Error('disk full');
    const abort = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const directory = {
      getFileHandle: vi.fn().mockResolvedValue({
        createWritable: vi.fn().mockResolvedValue({
          write: vi.fn().mockRejectedValue(failure),
          close,
          abort,
        }),
      }),
    } as unknown as FileSystemDirectoryHandle;

    await expect(writeRaw4DBlobToDirectory(directory, 'part.raw4d', new Blob(['x'])))
      .rejects.toBe(failure);
    expect(abort).toHaveBeenCalledWith(failure);
    expect(close).not.toHaveBeenCalled();
  });
});
