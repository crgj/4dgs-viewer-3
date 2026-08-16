import type { UiLanguage } from '../../app/i18n';
import type {
  RelightingLightPatch,
  RelightingSettings,
  RelightingState,
} from './RelightingTypes';
import './RelightingPanel.css';

const COPY = {
  zh: {
    title: 'Gaussian 重光照',
    local: 'GS2Mesh 代理 · 屏幕空间传递 · 纯前端',
    description: '用 GS2Mesh 的表面与法线承接点光源和阴影，再逐像素调制 Gaussian；原始颜色与透明度保持不变。',
    missingMesh: '请先在 GS2Mesh 插件中生成当前帧 Mesh。',
    ready: 'Mesh 代理已就绪。启用后可在视口拖动所选光源。',
    enabled: '启用重光照',
    blend: '影响强度',
    brightness: '光照亮度',
    background: '代理外亮度',
    quality: '光照纹理',
    lights: '点光源',
    add: '＋ 添加光源',
    remove: '删除光源',
    position: '位置',
    intensity: '强度',
    range: '范围',
    color: '颜色',
    shadows: '投射阴影',
    noLights: '还没有光源。添加一个点光源开始布光。',
    gizmo: '选择光源后可拖动视口中的 XYZ 操作轴；数值输入会实时同步。静止光源的阴影只更新一帧。',
  },
  en: {
    title: 'Gaussian Relighting',
    local: 'GS2Mesh proxy · screen-space transfer · frontend only',
    description: 'Light the GS2Mesh surface and normals with point lights and shadows, then modulate Gaussian pixels without changing source color or opacity.',
    missingMesh: 'Generate the current-frame mesh in GS2Mesh first.',
    ready: 'The mesh proxy is ready. Enable relighting, then drag the selected light in the viewport.',
    enabled: 'Enable relighting',
    blend: 'Influence',
    brightness: 'Lighting brightness',
    background: 'Outside-proxy brightness',
    quality: 'Lighting texture',
    lights: 'Point lights',
    add: '＋ Add light',
    remove: 'Remove light',
    position: 'Position',
    intensity: 'Intensity',
    range: 'Range',
    color: 'Color',
    shadows: 'Cast shadows',
    noLights: 'There are no lights yet. Add a point light to start lighting.',
    gizmo: 'Select a light and drag its XYZ viewport gizmo. Numeric edits stay synchronized. Static shadows update for one frame only.',
  },
} as const;

interface RelightingPanelProps {
  readonly hasMesh: boolean;
  readonly language: UiLanguage;
  readonly state: RelightingState;
  readonly onAddLight: () => void;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onLightChange: (id: string, patch: RelightingLightPatch) => void;
  readonly onRemoveLight: (id: string) => void;
  readonly onSelectLight: (id: string) => void;
  readonly onSettingsChange: (patch: Partial<RelightingSettings>) => void;
}

const axes = ['X', 'Y', 'Z'] as const;

export function RelightingPanel({
  hasMesh,
  language,
  state,
  onAddLight,
  onEnabledChange,
  onLightChange,
  onRemoveLight,
  onSelectLight,
  onSettingsChange,
}: RelightingPanelProps) {
  const copy = COPY[language];
  const selected = state.lights.find((light) => light.id === state.selectedLightId) ?? null;
  return (
    <section className={`relighting-card${state.enabled ? ' active' : ''}`} data-camera-input-block>
      <div className="relighting-heading">
        <span aria-hidden="true">☀</span>
        <div><strong>{copy.title}</strong><small>{copy.local}</small></div>
      </div>
      <p>{copy.description}</p>

      <div className={`relighting-availability${hasMesh ? ' ready' : ''}`}>
        <i />
        <span>{hasMesh ? copy.ready : copy.missingMesh}</span>
      </div>

      <label className="relighting-master-toggle">
        <span><strong>{copy.enabled}</strong><small>{state.enabled ? 'ON' : 'OFF'}</small></span>
        <input
          checked={state.enabled}
          disabled={!hasMesh}
          onChange={(event) => onEnabledChange(event.target.checked)}
          type="checkbox"
        />
      </label>

      <div className="relighting-settings-grid">
        <label>
          <span>{copy.blend}<b>{Math.round(state.blend * 100)}%</b></span>
          <input max="1" min="0" onChange={(event) => onSettingsChange({ blend: Number(event.target.value) })} step="0.01" type="range" value={state.blend} />
        </label>
        <label>
          <span>{copy.brightness}<b>{state.brightness.toFixed(1)}×</b></span>
          <input max="5" min="0" onChange={(event) => onSettingsChange({ brightness: Number(event.target.value) })} step="0.1" type="range" value={state.brightness} />
        </label>
        <label>
          <span>{copy.background}<b>{state.background.toFixed(1)}×</b></span>
          <input max="5" min="0" onChange={(event) => onSettingsChange({ background: Number(event.target.value) })} step="0.1" type="range" value={state.background} />
        </label>
        <label>
          <span>{copy.quality}</span>
          <select onChange={(event) => onSettingsChange({ textureScale: Number(event.target.value) })} value={state.textureScale}>
            <option value="0.5">50% · Fast</option>
            <option value="0.75">75% · Balanced</option>
            <option value="1">100% · Sharp</option>
          </select>
        </label>
      </div>

      <div className="relighting-lights-heading">
        <strong>{copy.lights}<b>{state.lights.length}/8</b></strong>
        <button disabled={!hasMesh || state.lights.length >= 8} onClick={onAddLight} type="button">{copy.add}</button>
      </div>
      {state.lights.length === 0 ? (
        <div className="relighting-empty">{copy.noLights}</div>
      ) : (
        <div className="relighting-light-list" role="listbox">
          {state.lights.map((light) => (
            <button
              aria-selected={selected?.id === light.id}
              className={selected?.id === light.id ? 'selected' : ''}
              key={light.id}
              onClick={() => onSelectLight(light.id)}
              role="option"
              type="button"
            >
              <i style={{ background: light.color }} />
              <span><strong>{light.name}</strong><small>{light.intensity.toFixed(1)} · {light.range.toFixed(2)} m</small></span>
              <b>{light.castShadows ? '◐' : '○'}</b>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="relighting-light-editor">
          <div className="relighting-editor-title">
            <strong>{selected.name}</strong>
            <button aria-label={copy.remove} onClick={() => onRemoveLight(selected.id)} title={copy.remove} type="button">×</button>
          </div>
          <fieldset>
            <legend>{copy.position}</legend>
            <div className="relighting-position-grid">
              {axes.map((axis, index) => (
                <label key={axis}>
                  <b className={`axis-${axis.toLowerCase()}`}>{axis}</b>
                  <input
                    aria-label={`${copy.position} ${axis}`}
                    onChange={(event) => {
                      const next = [...selected.position] as [number, number, number];
                      next[index] = Number(event.target.value);
                      onLightChange(selected.id, { position: next });
                    }}
                    step="0.05"
                    type="number"
                    value={Math.round(selected.position[index] * 1000) / 1000}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <div className="relighting-light-properties">
            <label><span>{copy.color}</span><input onChange={(event) => onLightChange(selected.id, { color: event.target.value })} type="color" value={selected.color} /></label>
            <label><span>{copy.intensity}</span><input max="50" min="0" onChange={(event) => onLightChange(selected.id, { intensity: Number(event.target.value) })} step="0.1" type="number" value={selected.intensity} /></label>
            <label><span>{copy.range}</span><input min="0.01" onChange={(event) => onLightChange(selected.id, { range: Number(event.target.value) })} step="0.1" type="number" value={Math.round(selected.range * 1000) / 1000} /></label>
          </div>
          <label className="relighting-shadow-toggle"><input checked={selected.castShadows} onChange={(event) => onLightChange(selected.id, { castShadows: event.target.checked })} type="checkbox" />{copy.shadows}</label>
          <p className="relighting-gizmo-hint">{copy.gizmo}</p>
        </div>
      )}
      {state.error && <div className="relighting-error" role="alert">{state.error}</div>}
    </section>
  );
}
