import { useEffect, useState } from 'react';
import type { UiLanguage } from '../i18n';
import { supportsFourCgsSceneExport, type ExportTarget } from './ExportCenterModel';

interface ExportCenterDialogProps {
  readonly deletedCount: number;
  readonly format: string;
  readonly frameCount: number;
  readonly inputBytes: number;
  readonly language: UiLanguage;
  readonly onClose: () => void;
  readonly onExport: (target: ExportTarget) => void;
  readonly sceneName: string;
  readonly segmentCount: number;
}

// #WDD-gpt 2026-08-18 - 导出中心先集中展示格式、范围、变换和预计内容，再复用原有浏览器内导出实现。
export function ExportCenterDialog(props: ExportCenterDialogProps) {
  const zh = props.language === 'zh';
  const [target, setTarget] = useState<ExportTarget>('fourcgs');
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
      title: '.4CGS',
      detail: supportsFourCgsSceneExport(props.format)
        ? (zh
            ? `从 ${props.format} 编码完整场景与全部片段${props.format === 'PLY4' || props.format === '4GS' ? '；Float32 输入会在 Worker 编码副本中量化为 FP16' : ''}`
            : `Encode the complete ${props.format} scene and all segments${props.format === 'PLY4' || props.format === '4GS' ? '; Float32 input is quantized to an FP16 Worker copy' : ''}`)
        : (zh ? `${props.format} 暂不支持编码为 .4cgs` : `${props.format} cannot currently be encoded as .4cgs`),
      disabled: !supportsFourCgsSceneExport(props.format),
    },
    { id: 'ply-sequence', title: zh ? 'PLY 序列' : 'PLY sequence', detail: zh ? `逐帧写入 ${props.frameCount} 个文件` : `Write ${props.frameCount} frame files` },
  ];
  const selected = options.find((option) => option.id === target)!;
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
              <div><dt>{zh ? '软删除' : 'Soft deleted'}</dt><dd>{props.deletedCount.toLocaleString()}</dd></div>
              <div><dt>{zh ? '场景变换' : 'Scene transform'}</dt><dd>{target === 'fourcgs' ? (zh ? '写入元数据' : 'Stored in metadata') : (zh ? '按导出器坐标' : 'Exporter coordinates')}</dd></div>
              <div><dt>{zh ? '输入大小' : 'Input size'}</dt><dd>{props.inputBytes > 0 ? `${(props.inputBytes / 1_000_000).toFixed(2)} MB` : '—'}</dd></div>
            </dl>
            <p>{target === 'fourcgs'
              ? (zh
                  ? `4CGS 会保留完整场景变换；软删除点在重新编码时压实。${props.format === 'PLY4' || props.format === '4GS' ? '场景内存保持 Float32，不会被原地改写。' : ''}`
                  : `4CGS preserves the full scene transform and compacts soft-deleted points when re-encoding.${props.format === 'PLY4' || props.format === '4GS' ? ' Scene memory remains Float32 and is not modified in place.' : ''}`)
              : (zh ? '浏览器将请求一个专用文件夹，并暂停播放后逐帧写入。' : 'The browser requests a dedicated folder, pauses playback, and writes each frame.')}</p>
          </div>
        </div>
        <footer><button className="quiet-button" onClick={props.onClose} type="button">{zh ? '取消' : 'Cancel'}</button><button className="primary-button" disabled={selected.disabled} onClick={() => props.onExport(target)} type="button">{zh ? '继续导出' : 'Continue export'}</button></footer>
      </section>
    </div>
  );
}
