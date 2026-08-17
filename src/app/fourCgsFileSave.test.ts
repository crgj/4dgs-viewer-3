import { describe, expect, it, vi } from 'vitest';
import {
  createFourCgsSavePickerOptions,
  isFilePickerAbort,
  writeBlobToFileHandle,
} from './fourCgsFileSave';

describe('4CGS save file flow', () => {
  it('opens a save-as picker in Downloads with a strict .4cgs type', () => {
    expect(createFourCgsSavePickerOptions('scene.4cgs')).toEqual({
      id: 'dong-editor-3-fourcgs-export',
      suggestedName: 'scene.4cgs',
      startIn: 'downloads',
      excludeAcceptAllOption: true,
      types: [{
        description: '4CGS Gaussian scene',
        accept: { 'application/octet-stream': ['.4cgs'] },
      }],
    });
  });

  it('writes and closes the user-approved file stream', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const handle = {
      createWritable: vi.fn().mockResolvedValue({ write, close, abort }),
    } as unknown as FileSystemFileHandle;
    const blob = new Blob(['4cgs']);

    await writeBlobToFileHandle(handle, blob);

    expect(write).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });

  it('recognizes a cancelled save picker without hiding real failures', () => {
    expect(isFilePickerAbort(new DOMException('cancelled', 'AbortError'))).toBe(true);
    expect(isFilePickerAbort(new DOMException('blocked', 'SecurityError'))).toBe(false);
  });

  it('aborts the file transaction when writing fails', async () => {
    const failure = new Error('disk full');
    const write = vi.fn().mockRejectedValue(failure);
    const close = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const handle = {
      createWritable: vi.fn().mockResolvedValue({ write, close, abort }),
    } as unknown as FileSystemFileHandle;

    await expect(writeBlobToFileHandle(handle, new Blob(['4cgs']))).rejects.toBe(failure);
    expect(abort).toHaveBeenCalledWith(failure);
    expect(close).not.toHaveBeenCalled();
  });
});
