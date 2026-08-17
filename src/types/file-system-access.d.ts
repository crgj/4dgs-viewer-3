// #WDD-gpt 2026-08-17 - lib.dom 已收录目录/文件句柄方法，但尚未收录 showDirectoryPicker；
// .ply 序列导出用它让用户选择本地写入目录。
interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}
