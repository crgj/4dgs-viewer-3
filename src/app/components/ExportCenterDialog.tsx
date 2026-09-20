import { useEffect, useState } from 'react';
import type { UiLanguage } from '../i18n';
import { uniqueRaw4DExportFilenames } from '../raw4dFileSave';
import type { FourCgsExportOptions } from '../../features/gaussian/formats/fourcgs/FourCgsTypes';
import {
  supportsFourCgsSceneExport,
  supportsFourCgsRaw4DZipExport,
  supportsRaw4DSceneExport,
  type ExportTarget,
} from './ExportCenterModel';

interface ExportCenterSegment {
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly name: string;
}

interface ExportCenterDialogProps {
  readonly deletedCount: number;
  readonly format: string;
  readonly frameCount: number;
  readonly inputBytes: number;
  readonly language: UiLanguage;
  readonly onClose: () => void;
  readonly onExport: (target: ExportTarget, options: FourCgsExportOptions & { readonly partCount: number }) => void;
  readonly sceneName: string;
  readonly segmentCount: number;
  readonly segments?: readonly ExportCenterSegment[];
}

// #WDD-gpt 2026-08-18 - 导出中心先集中展示格式、范围、变换和预计内容，再复用原有浏览器内导出实现。
export function ExportCenterDialog(props: ExportCenterDialogProps) {
  const zh = props.language === 'zh';
  const [target, setTarget] = useState<ExportTarget>(props.format === 'RAW4D' ? 'raw4d' : 'fourcgs');
  const [shLevel, setShLevel] = useState<1 | 2 | 3>(3);
  const [maximumEffectiveAlpha, setMaximumEffectiveAlpha] = useState(0.1);
  const [partCount, setPartCount] = useState(1);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [props]);
  const options: readonly { id: ExportTarget; title: string; detail: string; disabled?: boolean }[] = [
    {
      id: 'fourcgs',
      title: '.4CGS · V2.6',
      detail: supportsFourCgsSceneExport(props.format)
        ? (zh
            ? `从 ${props.format} 编码完整场景与全部片段${props.format === 'PLY4' || props.format === '4GS' ? '；Float32 输入会在 Worker 编码副本中量化为 FP16' : ''}`
            : `Encode the complete ${props.format} scene and all segments${props.format === 'PLY4' || props.format === '4GS' ? '; Float32 input is quantized to an FP16 Worker copy' : ''}`)
        : (zh ? `${props.format} 暂不支持编码为 .4cgs` : `${props.format} cannot currently be encoded as .4cgs`),
      disabled: !supportsFourCgsSceneExport(props.format),
    },
    {
      id: 'fourcgs-raw4d-zip',
      title: '.4CGS · RAW4D ZIP',
      detail: supportsFourCgsRaw4DZipExport(props.format, props.segmentCount)
        ? (zh
            ? `一个 .4cgs ZIP 内按时间轴写入 ${props.segmentCount} 个独立 .raw4d`
            : `Store ${props.segmentCount} timeline-ordered .raw4d segments inside one .4cgs ZIP`)
        : (zh ? 'RAW4D ZIP 版 4CGS 至少需要两个时序片段' : 'A RAW4D ZIP 4CGS requires at least two timeline segments'),
      disabled: !supportsFourCgsRaw4DZipExport(props.format, props.segmentCount),
    },
    {
      id: 'raw4d',
      title: '.RAW4D',
      detail: supportsRaw4DSceneExport(props.format)
        ? (props.segmentCount > 1
            ? (zh
                ? `保持原始分段，写入 ${props.segmentCount} 个独立 .raw4d 文件`
                : `Keep source boundaries and write ${props.segmentCount} separate .raw4d files`)
            : (zh ? '压实并保存当前片段为一个 .raw4d 文件' : 'Compact and save the current segment as one .raw4d file'))
        : (zh ? `${props.format} 暂不支持导出为 .raw4d` : `${props.format} cannot currently be exported as .raw4d`),
      disabled: !supportsRaw4DSceneExport(props.format),
    },
    { id: 'ply-sequence', title: zh ? 'PLY 序列' : 'PLY sequence', detail: zh ? `逐帧写入 ${props.frameCount} 个文件` : `Write ${props.frameCount} frame files` },
  ];
  const selected = options.find((option) => option.id === target)!;
  const segmentPreview = props.segments?.slice(0, 4) ?? [];
  const segmentOutputNames = uniqueRaw4DExportFilenames(props.segments?.map((segment) => segment.name) ?? []);
  return (
    <div className="export-center-backdrop" data-camera-input-block onPointerDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section aria-label={zh ? '导出中心' : 'Export Center'} aria-modal="true" className="export-center-dialog" role="dialog">
        <header><div><span>EXPORT CENTER</span><strong>{zh ? '导出场景' : 'Export scene'}</strong><p>{props.sceneName}</p></div><button aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} type="button">×</button></header>
        <div className="export-center-body">
          <div className="export-targets" role="radiogroup">{options.map((option) => (
            <button aria-checked={target === option.id} className={target === option.id ? 'active' : ''} disabled={option.disabled} key={option.id} onClick={() => setTarget(option.id)} role="radio" type="button">
              <i>{target === option.id ? '●' : '○'}</i><span><strong>{option.title}</strong><small>{option.detail}</small></span>
            </button>
          ))}</div>
          <div className="export-preflight">
            <span>{zh ? '导出检查' : 'Preflight'}</span>
            <dl>
              <div><dt>{zh ? '范围' : 'Scope'}</dt><dd>{zh ? '完整场景' : 'Full scene'}</dd></div>
              <div><dt>{zh ? '片段 / 帧' : 'Segments / frames'}</dt><dd>{`${props.segmentCount} / ${props.frameCount}`}</dd></div>
              <div><dt>{zh ? '输出文件' : 'Output files'}</dt><dd>{target === 'raw4d'
                ? `${props.segmentCount} × .raw4d`
                : target === 'fourcgs'
                  ? `${partCount} × .4cgs (V2.6)`
                  : target === 'fourcgs-raw4d-zip'
                    ? `1 × .4cgs ZIP (${props.segmentCount} RAW4D)`
                    : `${props.frameCount} × .ply`}</dd></div>
              <div><dt>{zh ? '软删除' : 'Soft deleted'}</dt><dd>{props.deletedCount.toLocaleString()}</dd></div>
              <div><dt>{zh ? '场景变换' : 'Scene transform'}</dt><dd>{target === 'fourcgs'
                ? (zh ? '写入元数据' : 'Stored in metadata')
                : target === 'raw4d' || target === 'fourcgs-raw4d-zip'
                  ? (zh ? '不写入；可先重设原点' : 'Not stored; bake first')
                  : (zh ? '按导出器坐标' : 'Exporter coordinates')}</dd></div>
              <div><dt>{zh ? '输入大小' : 'Input size'}</dt><dd>{props.inputBytes > 0 ? `${(props.inputBytes / 1_000_000).toFixed(2)} MB` : '—'}</dd></div>
            </dl>
            {target === 'fourcgs' && (
              <div className="export-fourcgs-options">
                <label><span>{zh ? 'SH 阶数' : 'SH level'}</span><select onChange={(event) => setShLevel(Number(event.target.value) as 1 | 2 | 3)} value={shLevel}>
                  <option value={1}>SH1 · 9D</option><option value={2}>SH2 · 24D</option><option value={3}>SH3 · 45D</option>
                </select></label>
                <label><span>{zh ? '最大有效 Alpha' : 'Maximum effective Alpha'}</span><input max="0.999999" min="0" onChange={(event) => setMaximumEffectiveAlpha(Number(event.target.value))} step="0.01" type="number" value={maximumEffectiveAlpha} /></label>
                <label><span>{zh ? '分段数' : 'Output parts'}</span><input max={Math.max(1, props.segmentCount)} min="1" onChange={(event) => setPartCount(Math.max(1, Math.min(props.segmentCount, Math.round(Number(event.target.value) || 1))))} step="1" type="number" value={partCount} /></label>
                <small>{zh
                  ? `Alpha 在每个原片段的所有整数帧均低于阈值时才删除；${partCount > 1 ? '输出按原片段边界连续分组。' : '输出一个完整文件。'}`
                  : `A point is removed only when Alpha stays below the threshold at every integer frame; ${partCount > 1 ? 'source segments are grouped consecutively.' : 'one complete file is written.'}`}</small>
              </div>
            )}
            {target === 'raw4d' && segmentPreview.length > 0 && (
              <ol className="export-segment-preview" aria-label={zh ? 'RAW4D 输出片段预览' : 'RAW4D output segment preview'}>
                {segmentPreview.map((segment, index) => (
                  <li key={`${segment.name}-${segment.firstFrame}-${segment.lastFrame}`}>
                    <span>{segmentOutputNames[index]}</span>
                    <b>{segment.firstFrame}–{segment.lastFrame}</b>
                  </li>
                ))}
                {props.segmentCount > segmentPreview.length && <li><span>+{props.segmentCount - segmentPreview.length}</span><b>{zh ? '更多片段' : 'more segments'}</b></li>}
              </ol>
            )}
            <p>{target === 'fourcgs'
              ? (zh
                  ? `4CGS 会保留完整场景变换；软删除点在重新编码时压实。${props.format === 'PLY4' || props.format === '4GS' ? '场景内存保持 Float32，不会被原地改写。' : ''}`
                  : `4CGS preserves the full scene transform and compacts soft-deleted points when re-encoding.${props.format === 'PLY4' || props.format === '4GS' ? ' Scene memory remains Float32 and is not modified in place.' : ''}`)
              : target === 'fourcgs-raw4d-zip'
                ? (zh
                    ? '浏览器会申请一个 .4cgs 文件，并将各段 RAW4D 以 Stored ZIP 条目逐块直接写入；保留片段边界和源精度，不需要独立服务。'
                    : 'The browser writes each RAW4D segment directly into one stored-entry .4cgs ZIP, preserving segment boundaries and source precision without a separate service.')
              : target === 'raw4d'
                ? (props.segmentCount > 1
                    ? (zh
                        ? '浏览器将请求一个专用文件夹，按时间轴顺序逐段压实并写入；原片段帧范围和源精度保持不变。'
                        : 'The browser requests a dedicated folder, then compacts and writes each timeline segment while preserving its frame range and source precision.')
                    : (zh
                        ? '软删除点会被物理压实；未重设原点的场景变换不会写入 RAW4D。'
                        : 'Soft-deleted points are physically compacted; an unbaked scene transform is not stored in RAW4D.'))
                : (zh ? '浏览器将请求一个专用文件夹，并暂停播放后逐帧写入。' : 'The browser requests a dedicated folder, pauses playback, and writes each frame.')}</p>
          </div>
        </div>
        <footer><button className="quiet-button" onClick={props.onClose} type="button">{zh ? '取消' : 'Cancel'}</button><button className="primary-button" disabled={selected.disabled || (target === 'fourcgs' && (!Number.isFinite(maximumEffectiveAlpha) || maximumEffectiveAlpha < 0 || maximumEffectiveAlpha >= 1))} onClick={() => props.onExport(target, { shLevel, maximumEffectiveAlpha, partCount })} type="button">{zh ? '继续导出' : 'Continue export'}</button></footer>
      </section>
    </div>
  );
}
