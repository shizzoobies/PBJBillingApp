import { RefreshCw, AlertTriangle } from 'lucide-react'

/**
 * Shown when the server refused this tab's save because its snapshot is out of
 * date (HTTP 409 `stale_workspace`).
 *
 * Deliberately BLOCKING, unlike `NewVersionToast`. The bulk save wipes and
 * re-inserts fifteen tables from the tab's snapshot, so continuing to work in a
 * tab whose saves are being refused means piling up edits that can never land —
 * and the alternative to refusing them is the June data wipe (docs/HANDOFF.md
 * §5). A reload is the only recovery, so the notice says so plainly rather than
 * offering a dismiss that leads nowhere.
 *
 * It is also honest that the unsaved change is lost: quietly merging a stale
 * snapshot into current data is exactly the failure this guard exists to
 * prevent, so we do not offer it.
 */
export function StaleWorkspaceNotice({ message }: { message?: string }) {
  return (
    <div className="stale-workspace-backdrop" role="alertdialog" aria-modal="true">
      <div className="stale-workspace-panel">
        <p className="stale-workspace-title">
          <AlertTriangle size={16} aria-hidden="true" /> This tab is out of date
        </p>
        <p className="stale-workspace-body">
          {message ??
            'Someone else changed something while this tab was open, so your last change was not saved.'}
        </p>
        <p className="stale-workspace-body muted-text">
          Reload to get the current data. Anything you just typed will need to be
          entered again — reloading protects the rest of the workspace from being
          overwritten with this tab&rsquo;s older copy.
        </p>
        <button
          type="button"
          className="primary-action"
          onClick={() => window.location.reload()}
        >
          <RefreshCw size={14} aria-hidden="true" /> Reload the page
        </button>
      </div>
    </div>
  )
}
