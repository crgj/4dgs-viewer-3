export const createRaw4DSavePickerOptions = (suggestedName: string) => ({
  id: 'dong-editor-3-raw4d-export',
  suggestedName,
  startIn: 'downloads',
  excludeAcceptAllOption: true,
  types: [{
    description: 'RAW4D Gaussian segment',
    accept: { 'application/octet-stream': ['.raw4d'] },
  }],
} as const);

// #WDD-gpt 2026-09-07 - 多段 RAW4D 必须写入用户授权的专用目录，避免浏览器拦截连续下载并保持一段一文件。
export const RAW4D_SEGMENTS_DIRECTORY_PICKER_OPTIONS = {
  id: 'dong-editor-3-raw4d-segments-v1',
  mode: 'readwrite',
  startIn: 'downloads',
} as const;

export function raw4DExportFilename(sourceName: string, fallbackIndex = 0): string {
  const leaf = sourceName.trim().replace(/\\/g, '/').split('/').at(-1) ?? '';
  const safeLeaf = leaf.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[. ]+$/g, '');
  const basename = safeLeaf.replace(/\.(?:raw4d|ply4|4gs|4cgs)$/i, '') || `segment-${fallbackIndex + 1}`;
  return `${basename}.raw4d`;
}

export function uniqueRaw4DExportFilenames(sourceNames: readonly string[]): readonly string[] {
  const used = new Set<string>();
  return sourceNames.map((sourceName, index) => {
    const filename = raw4DExportFilename(sourceName, index);
    const stem = filename.slice(0, -'.raw4d'.length);
    let candidate = filename;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${stem}-${suffix}.raw4d`;
      suffix += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export async function writeRaw4DBlobToDirectory(
  directory: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort(error);
    } catch {
      // 原始写入错误优先返回；浏览器可能已自动关闭失败的写入流。
    }
    throw error;
  }
}
