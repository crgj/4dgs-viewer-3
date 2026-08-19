export type AppNoticeTone = 'warning' | 'error';

interface AppNoticeDialogProps {
  readonly confirmLabel: string;
  readonly message: string;
  readonly onClose: () => void;
  readonly title: string;
  readonly tone: AppNoticeTone;
  readonly details?: string;
  readonly suggestion?: string;
  readonly retryLabel?: string;
  readonly onRetry?: () => void;
}

// #WDD-gpt 2026-08-17 - 用应用内最高层提示框替代浏览器 alert，保持主题、焦点和摄像机输入隔离一致。
export function AppNoticeDialog({ confirmLabel, details, message, onClose, onRetry, retryLabel, suggestion, title, tone }: AppNoticeDialogProps) {
  return (
    <div className="memory-confirm-backdrop app-notice-backdrop" data-camera-input-block>
      <section aria-label={title} aria-modal="true" className={`memory-confirm-dialog app-notice-dialog ${tone}`} role="alertdialog">
        <header>
          <span>{tone === 'error' ? 'ERROR' : 'NOTICE'}</span>
          <strong>{title}</strong>
          <p>{message}</p>
        </header>
        {suggestion && <p className="app-notice-suggestion"><b>→</b>{suggestion}</p>}
        {details && <details className="app-notice-details"><summary>Technical details</summary><pre>{details}</pre></details>}
        <footer>
          {onRetry && <button className="quiet-button" onClick={onRetry} type="button">{retryLabel ?? 'Retry'}</button>}
          <button autoFocus className="primary-button" onClick={onClose} type="button">{confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}
