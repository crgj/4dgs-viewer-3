// #WDD-gpt 2026-08-17 - lib.dom 已收录目录/文件句柄方法，但尚未收录目录与另存为选择器；
// .ply 序列选择目录，单文件 .4cgs 使用另存为句柄选择目录和文件名。
interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker(options?: {
    excludeAcceptAllOption?: boolean;
    id?: string;
    startIn?: string;
    suggestedName?: string;
    types?: ReadonlyArray<{
      description?: string;
      accept: Readonly<Record<string, readonly string[]>>;
    }>;
  }): Promise<FileSystemFileHandle>;
}
