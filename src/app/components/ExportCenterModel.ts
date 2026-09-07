export type ExportTarget = 'fourcgs' | 'raw4d' | 'ply-sequence';

// #WDD-gpt 2026-08-18 - 4CGS 编码只接受已有 Canonical 时序内存的格式，PLY4 与 RAW4D 使用同一路径。
export function supportsFourCgsSceneExport(format: string): boolean {
  return format === 'RAW4D' || format === 'PLY4' || format === '4GS' || format === '4CGS';
}

// #WDD-gpt 2026-09-07 - 只要场景已有 Canonical 时序内存，就允许逐片段写回标准 RAW4D。
export function supportsRaw4DSceneExport(format: string): boolean {
  return supportsFourCgsSceneExport(format);
}
