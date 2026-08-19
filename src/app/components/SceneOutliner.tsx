import type { ViewportCameraState, ViewportStatus } from '../../features/viewport/runtime/ViewportRuntime';
import type { UiLanguage } from '../i18n';

interface SceneOutlinerProps {
  readonly cameraBookmarks: readonly (ViewportCameraState | null)[];
  readonly gaussianVisible: boolean;
  readonly gs2MeshVisible: boolean;
  readonly hasMesh: boolean;
  readonly language: UiLanguage;
  readonly lightCount: number;
  readonly onFocusScene: () => void;
  readonly onFocusSelection: () => void;
  readonly onFrameChange: (frame: number) => void;
  readonly onGaussianVisibleChange: (visible: boolean) => void;
  readonly onMeshVisibleChange: (visible: boolean) => void;
  readonly onRecallBookmark: (index: number) => void;
  readonly onSaveBookmark: (index: number) => void;
  readonly onToggleAxes: () => void;
  readonly onToggleEnvelope: () => void;
  readonly onToggleGrid: () => void;
  readonly onToggleRuler: () => void;
  readonly sceneName: string;
  readonly recoverySources: readonly string[];
  readonly showAxes: boolean;
  readonly showEnvelope: boolean;
  readonly showGrid: boolean;
  readonly showRuler: boolean;
  readonly status: ViewportStatus;
  readonly workspaceState: 'empty' | 'saving' | 'saved' | 'recovery';
  readonly workspaceSavedAt: number | null;
}

function VisibilityButton({ label, onClick, visible }: { label: string; onClick: () => void; visible: boolean }) {
  return <button aria-label={label} aria-pressed={visible} className="outliner-eye" onClick={onClick} type="button">{visible ? '◉' : '○'}</button>;
}

// #WDD-gpt 2026-08-18 - Outliner 只呈现场景实体、片段、灯光和辅助对象，不把插件步骤混入场景层级。
export function SceneOutliner(props: SceneOutlinerProps) {
  const zh = props.language === 'zh';
  const sequence = props.status.raw4dSequence;
  const workspaceLabel = props.workspaceState === 'saving'
    ? (zh ? '正在自动保存' : 'Autosaving')
    : props.workspaceState === 'saved'
      ? (zh ? '工作区已保存' : 'Workspace saved')
      : props.workspaceState === 'recovery'
        ? (zh ? '等待重新导入以恢复' : 'Reopen files to recover')
        : (zh ? '尚未打开场景' : 'No scene open');
  return (
    <section className="scene-outliner" role="tabpanel">
      <header className={`workspace-state ${props.workspaceState}`}>
        <i />
        <div><strong>{workspaceLabel}</strong>{props.workspaceSavedAt && <small>{new Date(props.workspaceSavedAt).toLocaleTimeString()}</small>}</div>
      </header>
      {props.workspaceState === 'recovery' && props.recoverySources.length > 0 && (
        <div className="workspace-recovery-files">
          <strong>{zh ? '重新导入同一文件后自动恢复' : 'Reopen the same files to restore'}</strong>
          {props.recoverySources.map((name) => <span key={name}>{name}</span>)}
        </div>
      )}

      <div className="outliner-command-grid">
        <button disabled={props.status.phase !== 'ready'} onClick={props.onFocusScene} type="button"><kbd>Home</kbd>{zh ? '显示全部' : 'Frame all'}</button>
        <button disabled={props.status.phase !== 'ready'} onClick={props.onFocusSelection} type="button"><kbd>F</kbd>{zh ? '聚焦选中' : 'Focus selected'}</button>
      </div>

      <div className="outliner-tree">
        <div className="outliner-row root"><span className="outliner-chevron">⌄</span><i className="outliner-icon scene" /><strong>{props.sceneName}</strong></div>
        <div className="outliner-row object">
          <span className="outliner-branch">├</span><i className="outliner-icon gaussian" />
          <span>{zh ? 'Gaussian 场景' : 'Gaussian scene'}</span>
          <VisibilityButton label={zh ? '显示或隐藏高斯' : 'Show or hide Gaussians'} onClick={() => props.onGaussianVisibleChange(!props.gaussianVisible)} visible={props.gaussianVisible} />
        </div>
        {sequence?.segments.map((segment, index) => (
          <button
            className={index === sequence.segmentIndex ? 'outliner-row segment active' : 'outliner-row segment'}
            key={`${segment.name}-${index}`}
            onClick={() => props.onFrameChange(segment.firstFrame - sequence.firstFrame)}
            type="button"
          >
            <span className="outliner-branch">│</span><i className="outliner-icon segment" />
            <span title={segment.name}>{segment.name}</span><small>{segment.firstFrame}–{segment.lastFrame}</small>
          </button>
        ))}
        <div className={`outliner-row object${props.hasMesh ? '' : ' disabled'}`}>
          <span className="outliner-branch">├</span><i className="outliner-icon mesh" />
          <span>{zh ? '重建 Mesh' : 'Reconstructed mesh'}</span>
          <VisibilityButton label={zh ? '显示或隐藏 Mesh' : 'Show or hide mesh'} onClick={() => props.onMeshVisibleChange(!props.gs2MeshVisible)} visible={props.hasMesh && props.gs2MeshVisible} />
        </div>
        <div className="outliner-row object"><span className="outliner-branch">├</span><i className="outliner-icon light" /><span>{zh ? '灯光' : 'Lights'}</span><small>{props.lightCount}</small></div>
        <div className="outliner-row object"><span className="outliner-branch">└</span><i className="outliner-icon helper" /><span>{zh ? '辅助对象' : 'Helpers'}</span></div>
        <div className="outliner-helper-grid">
          <VisibilityButton label={zh ? '网格' : 'Grid'} onClick={props.onToggleGrid} visible={props.showGrid} />
          <button onClick={props.onToggleGrid} type="button">{zh ? '网格' : 'Grid'}</button>
          <VisibilityButton label={zh ? '坐标轴' : 'Axes'} onClick={props.onToggleAxes} visible={props.showAxes} />
          <button onClick={props.onToggleAxes} type="button">{zh ? '坐标轴' : 'Axes'}</button>
          <VisibilityButton label={zh ? '身高尺' : 'Height ruler'} onClick={props.onToggleRuler} visible={props.showRuler} />
          <button onClick={props.onToggleRuler} type="button">{zh ? '身高尺' : 'Height ruler'}</button>
          <VisibilityButton label={zh ? '外包络' : 'Envelope'} onClick={props.onToggleEnvelope} visible={props.showEnvelope} />
          <button onClick={props.onToggleEnvelope} type="button">{zh ? '外包络' : 'Envelope'}</button>
        </div>
      </div>

      <div className="camera-bookmarks">
        <strong>{zh ? '视角书签' : 'View bookmarks'}</strong>
        <p>{zh ? '空槽点击保存；已保存槽点击恢复。' : 'Click an empty slot to save, or a saved slot to recall.'}</p>
        <div>{props.cameraBookmarks.map((bookmark, index) => (
          <span className={bookmark ? 'saved' : 'empty'} key={index}>
            {/* #WDD-gpt 2026-08-19 - 空书签槽本身即可保存，已保存槽点击恢复，消除禁用编号造成的“功能不可用”误解。 */}
            <button
              aria-label={`${zh ? (bookmark ? '恢复视角' : '保存视角') : (bookmark ? 'Recall view' : 'Save view')} ${index + 1}`}
              onClick={() => bookmark ? props.onRecallBookmark(index) : props.onSaveBookmark(index)}
              type="button"
            >
              <b>{index + 1}</b><small>{zh ? (bookmark ? '恢复' : '保存') : (bookmark ? 'Recall' : 'Save')}</small>
            </button>
            <button
              aria-label={`${zh ? '覆盖保存视角' : 'Overwrite view'} ${index + 1}`}
              disabled={!bookmark}
              onClick={() => props.onSaveBookmark(index)}
              type="button"
            >↻</button>
          </span>
        ))}</div>
      </div>
    </section>
  );
}
