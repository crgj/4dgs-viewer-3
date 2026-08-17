export const createFourCgsSavePickerOptions = (suggestedName: string) => ({
  id: 'dong-editor-3-fourcgs-export',
  suggestedName,
  startIn: 'downloads',
  excludeAcceptAllOption: true,
  types: [{
    description: '4CGS Gaussian scene',
    accept: { 'application/octet-stream': ['.4cgs'] },
  }],
} as const);

export const isFilePickerAbort = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
);

// #WDD-gpt 2026-08-17 - 单文件 4CGS 通过用户授权的文件句柄直接提交，避免申请整个下载目录权限。
export async function writeBlobToFileHandle(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort(error);
    } catch {
      // 原始写入错误优先返回；部分浏览器在写入失败后会自动关闭流。
    }
    throw error;
  }
}
