// #WDD-gpt 2026-09-20 - 只持久保存用户授权的目录句柄，刷新复用目录；不在启动时弹权限请求。
type AuthorizedDirectory = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};
// #WDD-gpt 2026-09-20 - 显式记录 OPFS 选择，以区分首次访问与用户已经完成设置。
const DATABASE = 'show-dance-preferences-v1';
const STORE = 'settings';

async function directoryTransaction(write: boolean, directory?: FileSystemDirectoryHandle | null) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<FileSystemDirectoryHandle | 'opfs' | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE, write ? 'readwrite' : 'readonly');
      const store = transaction.objectStore(STORE);
      const request = write ? store.put(directory || 'opfs', 'directory') : store.get('directory');
      transaction.oncomplete = () => resolve(write ? undefined : request.result);
      transaction.onabort = () => reject(transaction.error || new Error('无法保存缓存目录设置'));
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export const loadCacheDirectory = () => directoryTransaction(false);
export const saveCacheDirectory = (directory: FileSystemDirectoryHandle | null) => directoryTransaction(true, directory);
export const cacheDirectoryPermission = (directory: FileSystemDirectoryHandle, request = false) => {
  const handle = directory as AuthorizedDirectory;
  return request ? handle.requestPermission({ mode: 'readwrite' }) : handle.queryPermission({ mode: 'readwrite' });
};
