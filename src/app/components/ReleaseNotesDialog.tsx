import type { UiCopy } from '../i18n';
import type { ReleaseNote } from '../releaseNotes';

interface ReleaseNotesDialogProps {
  readonly copy: UiCopy;
  readonly currentVersion: string;
  readonly onClose: () => void;
  readonly releases: readonly ReleaseNote[];
}

// #WDD-gpt 2026-08-16 - 更新信息使用独立顶层面板，完整展示当前版本与历史版本且不占用编辑器检查器空间。
export function ReleaseNotesDialog({ copy, currentVersion, onClose, releases }: ReleaseNotesDialogProps) {
  const currentRelease = releases.find((release) => release.version === currentVersion) ?? releases[0];
  const history = releases.filter((release) => release !== currentRelease);

  return (
    <div
      className="release-notes-backdrop"
      data-camera-input-block
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section aria-label={copy.releaseNotes} aria-modal="true" className="release-notes-dialog" role="dialog">
        <header className="release-notes-header">
          <div>
            <span>{copy.releaseNotesKicker}</span>
            <strong>{copy.releaseNotes}</strong>
            <p>{copy.releaseNotesDescription}</p>
          </div>
          <button aria-label={copy.close} className="release-notes-close" onClick={onClose} type="button">×</button>
        </header>

        {currentRelease ? (
          <article className="release-notes-current">
            <header>
              <div>
                <span>{copy.releaseNotesLatest}</span>
                <strong>v{currentRelease.version}</strong>
              </div>
              <time dateTime={currentRelease.date}>{currentRelease.date}</time>
            </header>
            <ul>
              {currentRelease.changes.map((change) => <li key={change}>{change}</li>)}
            </ul>
          </article>
        ) : (
          <p className="release-notes-empty">{copy.releaseNotesEmpty}</p>
        )}

        {history.length > 0 && (
          <section className="release-notes-history">
            <h3>{copy.releaseNotesHistory}</h3>
            <div>
              {history.map((release) => (
                <details key={release.version}>
                  <summary>
                    <strong>v{release.version}</strong>
                    <time dateTime={release.date}>{release.date}</time>
                    <span aria-hidden="true">⌄</span>
                  </summary>
                  <ul>
                    {release.changes.map((change) => <li key={change}>{change}</li>)}
                  </ul>
                </details>
              ))}
            </div>
          </section>
        )}

        <footer>
          <small>{copy.releaseNotesSource}</small>
          <button className="primary-button" onClick={onClose} type="button">{copy.close}</button>
        </footer>
      </section>
    </div>
  );
}
