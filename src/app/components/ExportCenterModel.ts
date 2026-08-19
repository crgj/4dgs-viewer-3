export type ExportTarget = 'fourcgs' | 'ply-sequence';

// #WDD-gpt 2026-08-18 - 4CGS 编码只接受已有 Canonical 时序内存的格式，PLY4 与 RAW4D 使用同一路径。
export function supportsFourCgsSceneExport(format: string): boolean {
  return format === 'RAW4D' || format === 'PLY4' || format === '4CGS';
}
