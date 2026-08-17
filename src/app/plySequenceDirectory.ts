// #WDD-gpt 2026-08-17 - PLY 序列目录选择固定从“下载”打开，并用新 ID 记住获准的专用子目录。
export const PLY_SEQUENCE_DIRECTORY_PICKER_OPTIONS = {
  id: 'dong-editor-3-ply-sequence-v2',
  mode: 'readwrite',
  startIn: 'downloads',
} as const;

export const isDirectoryPickerAbort = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
);
