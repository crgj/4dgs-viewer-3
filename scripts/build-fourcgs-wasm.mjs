import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import wabtFactory from 'wabt';

// #WDD-gpt 2026-08-16 - 在正式前端构建前固定生成 SH 编码 WASM，避免运行时下载编译器或依赖后端服务。
const sourcePath = resolve('src/features/gaussian/formats/fourcgs/wasm/fourcgs_sh_assign.wat');
const outputPath = resolve('src/features/gaussian/formats/fourcgs/wasm/fourcgs_sh_assign.wasm');
const wabt = await wabtFactory();
const source = await readFile(sourcePath, 'utf8');
const module = wabt.parseWat(sourcePath, source);
module.resolveNames();
module.validate();
const { buffer } = module.toBinary({ log: false, write_debug_names: true });
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, buffer);
module.destroy();
