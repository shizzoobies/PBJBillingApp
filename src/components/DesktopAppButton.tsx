import { useState } from 'react'
import { desktopHandoffRequest } from '../lib/api'

/**
 * The one-click handoff into the Windows desktop app, up in the topbar where
 * it can be found (it started life buried in Settings → Sign-in; Alex's
 * call: "let's not bury it").
 *
 * Renders nothing inside the desktop shell itself — its user agent carries
 * PBJDesktopShell, and offering "open the desktop app" from within the
 * desktop app is noise. The button mints a one-time token server-side and
 * navigates to the returned pbjsa:// URL; the browser asks "Open PBJ
 * Accounting?" and the installed app opens signed in. This lives on a page,
 * not in the sign-in email, because web mail clients strip app-opening link
 * schemes — an email button renders and does nothing.
 */
export function DesktopAppButton() {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  if (navigator.userAgent.includes('PBJDesktopShell')) return null

  const openDesktop = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const { url } = await desktopHandoffRequest()
      window.location.assign(url)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className="ghost-button desktop-open-button"
      disabled={busy}
      onClick={() => void openDesktop()}
      title={
        failed
          ? 'Could not prepare the desktop sign-in — try again in a moment.'
          : 'Open the installed Windows app, signed in as you. Nothing happens? Install the desktop app first.'
      }
      type="button"
    >
      {busy ? 'Opening…' : failed ? 'Try again' : 'Open in desktop'}
    </button>
  )
}
