export type AppNoticeTone = 'warning' | 'error';

interface AppNoticeDialogProps {
  readonly confirmLabel: string;
  readonly message: string;
  readonly onClose: () => void;
  readonly title: string;
  readonly tone: AppNoticeTone;
}

// #WDD-gpt 2026-08-17 - 用应用内最高层提示框替代浏览器 alert，保持主题、焦点和摄像机输入隔离一致。
export function AppNoticeDialog({ confirmLabel, message, onClose, title, tone }: AppNoticeDialogProps) {
  return (
    <div className="memory-confirm-backdrop app-notice-backdrop" data-camera-input-block>
      <section aria-label={title} aria-modal="true" className={`memory-confirm-dialog app-notice-dialog ${tone}`} role="alertdialog">
        <header>
          <span>{tone === 'error' ? 'ERROR' : 'NOTICE'}</span>
          <strong>{title}</strong>
          <p>{message}</p>
        </header>
        <footer>
          <button autoFocus className="primary-button" onClick={onClose} type="button">{confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}
