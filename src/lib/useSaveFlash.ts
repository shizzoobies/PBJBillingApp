import { useEffect, useRef, useState } from 'react'
import { useAppContext } from '../AppContext'

export type SaveFlashState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Drives a small per-field "Saving… / Saved / Couldn't save" badge. Call
 * `flash()` the moment a field commits a change. It shows "Saving…", then
 * shortly after resolves to "Saved" (or "Couldn't save" if the workspace sync
 * has errored / gone offline). The authoritative error display is the global
 * sync banner in the header — this is the reassuring near-the-field echo.
 */
export function useSaveFlash(): { state: SaveFlashState; flash: () => void } {
  const { dataSyncState } = useAppContext()
  // Keep the latest sync state readable inside the deferred timer without
  // re-arming it on every state change. Updated in an effect (never read or
  // written during render).
  const syncRef = useRef(dataSyncState)
  const [state, setState] = useState<SaveFlashState>('idle')
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    syncRef.current = dataSyncState
  }, [dataSyncState])

  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => window.clearTimeout(t))
      timersRef.current = []
    }
  }, [])

  const flash = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t))
    timersRef.current = []
    setState('saving')
    timersRef.current.push(
      window.setTimeout(() => {
        const s = syncRef.current
        const ok = s !== 'error' && s !== 'offline'
        setState(ok ? 'saved' : 'error')
        if (ok) {
          timersRef.current.push(window.setTimeout(() => setState('idle'), 1800))
        }
      }, 850),
    )
  }

  return { state, flash }
}
