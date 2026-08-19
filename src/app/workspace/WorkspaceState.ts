import type { GaussianRenderMode } from '../../features/gaussian/runtime/GaussianRenderMode';
import type {
  ViewportCameraState,
  ViewportGaussianEditSnapshot,
  ViewportTransform,
} from '../../features/viewport/runtime/ViewportRuntime';

export const WORKSPACE_DRAFT_KEY = 'dong-editor-3-autosave';
const WORKSPACE_DATABASE = 'dong-editor-3-workspaces';
const WORKSPACE_STORE = 'drafts';

export interface WorkspaceSourceIdentity {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
}

export interface WorkspaceViewState {
  readonly camera: ViewportCameraState | null;
  readonly cameraBookmarks: readonly (ViewportCameraState | null)[];
  readonly currentFrame: number;
  readonly gaussianVisible: boolean;
  readonly gs2MeshVisible: boolean;
  readonly inspectorTab: 'scene' | 'transform' | 'gaussian' | 'performance';
  readonly playbackFps: number;
  readonly renderMode: GaussianRenderMode;
  readonly sceneTransform: ViewportTransform;
  readonly shLevel: number;
  readonly showAxes: boolean;
  readonly showGaussianEnvelope: boolean;
  readonly showGrid: boolean;
  readonly showHeightRuler: boolean;
}

export interface WorkspaceDraft {
  readonly schemaVersion: 1;
  readonly savedAt: number;
  readonly sceneName: string;
  readonly sources: readonly WorkspaceSourceIdentity[];
  readonly view: WorkspaceViewState;
  readonly edits: readonly ViewportGaussianEditSnapshot[];
}

export function workspaceSourceIdentities(files: readonly File[]): readonly WorkspaceSourceIdentity[] {
  return files.map((file) => ({
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  }));
}

export function workspaceSourcesMatch(
  expected: readonly WorkspaceSourceIdentity[],
  files: readonly File[],
): boolean {
  if (expected.length !== files.length) return false;
  return expected.every((source, index) => {
    const file = files[index];
    return source.name === file.name
      && source.size === file.size
      && source.lastModified === file.lastModified;
  });
}

function openWorkspaceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WORKSPACE_STORE)) {
        request.result.createObjectStore(WORKSPACE_STORE);
      }
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开工作区恢复数据库。'));
    request.onsuccess = () => resolve(request.result);
  });
}

function workspaceRequest<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openWorkspaceDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(WORKSPACE_STORE, mode);
    const request = operation(transaction.objectStore(WORKSPACE_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('工作区状态读写失败。'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => database.close();
    transaction.onabort = () => database.close();
  }));
}

// #WDD-gpt 2026-08-18 - 使用 IndexedDB 保存跨片段编辑位集与视口状态，避免刷新后只剩一个没有实际恢复能力的“未保存”标记。
export function loadWorkspaceDraft(): Promise<WorkspaceDraft | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return workspaceRequest<WorkspaceDraft | undefined>('readonly', (store) => store.get(WORKSPACE_DRAFT_KEY))
    .then((draft) => draft?.schemaVersion === 1 ? draft : null);
}

export function saveWorkspaceDraft(draft: WorkspaceDraft): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return workspaceRequest<IDBValidKey>('readwrite', (store) => store.put(draft, WORKSPACE_DRAFT_KEY))
    .then(() => undefined);
}

export function clearWorkspaceDraft(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return workspaceRequest<undefined>('readwrite', (store) => store.delete(WORKSPACE_DRAFT_KEY))
    .then(() => undefined);
}
