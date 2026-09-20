// #WDD-gpt 2026-09-20 - 下载和磁盘缓存专用 Worker，复用原子完成标记、Web Locks 和单路 FIFO。
import { AlbumDiskCache } from './AlbumDiskCache';
const cache = new AlbumDiskCache({ concurrency: 1, preserveOrder: true });
cache.subscribe((state) => self.postMessage({ type: 'state', state }));
self.onmessage = async ({ data }) => {
  const { id, method, args } = data;
  try {
    let value: unknown;
    switch (method) {
      case 'initialize': value = await cache.initialize(args[0], args[1], args[2]); break;
      case 'get': value = await cache.get(args[0]); break;
      case 'start': cache.start(args[0]); break;
      case 'resume': cache.resume(args[0]); break;
      case 'stop': await cache.stop(); break;
      case 'clear': await cache.clear(); break;
      case 'persistent': cache.state = { ...cache.state, persistent: args[0] }; self.postMessage({ type: 'state', state: cache.state }); break;
      default: throw new Error(`未知缓存命令：${method}`);
    }
    self.postMessage({ type: 'result', id, value });
  } catch (error) { self.postMessage({ type: 'result', id, error: String(error) }); }
};
