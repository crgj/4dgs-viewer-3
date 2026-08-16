import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import wabtFactory from 'wabt';

const sourcePath = resolve('src/plugins/gs2mesh/wasm/gs2mesh_core.wat');
const outputPath = resolve('src/plugins/gs2mesh/wasm/gs2mesh_core.wasm');
const wabt = await wabtFactory();
const source = await readFile(sourcePath, 'utf8');
const module = wabt.parseWat(sourcePath, source, { bulk_memory: true });
module.resolveNames();
module.validate({ bulk_memory: true });
const { buffer } = module.toBinary({ log: false, write_debug_names: true });
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, buffer);
module.destroy();
