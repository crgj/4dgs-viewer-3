import type { UiLanguage } from '../i18n';

export interface AppErrorDescription {
  readonly title: string;
  readonly summary: string;
  readonly suggestion: string;
  readonly details: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// #WDD-gpt 2026-08-18 - 将 Worker、内存、文件和权限故障映射为一致的“发生了什么 / 下一步 / 技术详情”结构。
export function describeAppError(error: unknown, language: UiLanguage, context?: string): AppErrorDescription {
  const details = errorText(error);
  const normalized = `${context ?? ''} ${details}`.toLowerCase();
  const zh = language === 'zh';
  if (/worker|stopped unexpectedly|terminated|后台线程/.test(normalized)) {
    return {
      title: zh ? '后台处理已中断' : 'Background processing stopped',
      summary: zh ? '当前操作没有完成，但源文件和当前场景数据没有被覆盖。' : 'The operation did not finish, but the source files and current scene were not overwritten.',
      suggestion: zh ? '请重试一次；若再次发生，请降低内存模式后重新导入同一场景。' : 'Retry once. If it repeats, lower the memory mode and reopen the same scene.',
      details,
    };
  }
  if (/out of memory|allocation|allocate|memory|内存|显存/.test(normalized)) {
    return {
      title: zh ? '可用内存不足' : 'Not enough available memory',
      summary: zh ? '浏览器无法为本次操作分配所需内存，操作已安全停止。' : 'The browser could not allocate enough memory, so the operation stopped safely.',
      suggestion: zh ? '关闭其他大型标签页，切换到兼容或平衡模式，再重新执行。' : 'Close other large tabs, switch to Compatible or Balanced mode, then retry.',
      details,
    };
  }
  if (/permission|notallowed|security|system file|目录|授权/.test(normalized)) {
    return {
      title: zh ? '没有获得文件访问权限' : 'File access was not granted',
      summary: zh ? '浏览器没有允许编辑器访问所选文件或目录。' : 'The browser did not allow the editor to access the selected file or folder.',
      suggestion: zh ? '请选择普通文件或“下载”中的专用子目录，并在浏览器提示中允许访问。' : 'Choose a regular file or a dedicated Downloads subfolder and approve the browser prompt.',
      details,
    };
  }
  if (/invalid|mismatch|corrupt|unsupported|checksum|不匹配|损坏|不支持/.test(normalized)) {
    return {
      title: zh ? '场景数据无法使用' : 'Scene data cannot be used',
      summary: zh ? '文件格式、片段顺序或数据校验没有通过。' : 'The file format, segment order, or data validation did not pass.',
      suggestion: zh ? '确认文件完整且来自同一序列；多段 RAW4D 请一次按完整集合重新导入。' : 'Verify the files are complete and from one sequence; reopen the full RAW4D set together.',
      details,
    };
  }
  return {
    title: zh ? '操作未完成' : 'Operation not completed',
    summary: zh ? '编辑器已停止当前操作，现有场景仍保持可用。' : 'The editor stopped the current operation and kept the existing scene available.',
    suggestion: zh ? '请重试；如果问题重复出现，可展开技术详情定位具体阶段。' : 'Retry. If the issue repeats, expand Technical details to identify the failing stage.',
    details,
  };
}
