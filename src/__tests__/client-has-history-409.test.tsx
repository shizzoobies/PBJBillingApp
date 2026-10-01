import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientHasHistoryApiError, StaleWorkspaceApiError, saveAppData } from '../lib/api'
import { StaleWorkspaceNotice } from '../components/StaleWorkspaceNotice'
import type { AppData } from '../lib/types'

/**
 * The bulk save refuses (409 `client_has_history`) a payload that would delete
 * a client with time entries or invoices. It is a different refusal from the
 * stale-tab one (`stale_workspace`), so it must reach the tab as its own error,
 * carry the server's sentence, and end the retry loop - the same payload would
 * be refused again every four seconds otherwise.
 */

const SENTENCE = 'Acme has time logged and cannot be deleted. Reload and mark it inactive instead.'

const refusal = (error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saveAppData and the two 409s', () => {
  it('throws ClientHasHistoryApiError carrying the server sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal('client_has_history', SENTENCE)))
    const error = await saveAppData({} as AppData).catch((e) => e)
    expect(error).toBeInstanceOf(ClientHasHistoryApiError)
    expect(error.message).toBe(SENTENCE)
    expect(error.status).toBe(409)
    // Not confused with the stale-tab refusal.
    expect(error).not.toBeInstanceOf(StaleWorkspaceApiError)
  })

  it('still throws StaleWorkspaceApiError for stale_workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal('stale_workspace', 'Reload.')))
    const error = await saveAppData({} as AppData).catch((e) => e)
    expect(error).toBeInstanceOf(StaleWorkspaceApiError)
    expect(error).not.toBeInstanceOf(ClientHasHistoryApiError)
  })
})

describe('the tab after a client_has_history refusal', () => {
  const appSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'),
    'utf8',
  )

  it('latches the save loop shut, so it does not retry the same refused save', () => {
    const at = appSource.indexOf('if (error instanceof ClientHasHistoryApiError) {')
    expect(at).toBeGreaterThan(-1)
    const branch = appSource.slice(at, appSource.indexOf('return', at))
    // The latch `saveNow` checks first and the 4s retry effect goes through.
    expect(branch).toContain('staleWorkspaceRef.current = true')
    expect(branch).toContain('setStaleWorkspaceMessage(error.message)')
    // The latch is read before anything is sent.
    const saveNowAt = appSource.indexOf('const saveNow = useCallback')
    const guardAt = appSource.indexOf('if (staleWorkspaceRef.current) {', saveNowAt)
    const sendAt = appSource.indexOf('saveAppData(dataRef.current)', saveNowAt)
    expect(guardAt).toBeGreaterThan(saveNowAt)
    expect(guardAt).toBeLessThan(sendAt)
  })

  it('is handled before the generic error path that leaves the save to retry', () => {
    const own = appSource.indexOf('if (error instanceof ClientHasHistoryApiError) {')
    const generic = appSource.indexOf('// Leave dirtyRef set so the retry effect', own)
    expect(own).toBeGreaterThan(-1)
    expect(generic).toBeGreaterThan(own)
  })
})

describe('the notice it puts up', () => {
  it('shows the server sentence and a reload button under its own title', () => {
    render(<StaleWorkspaceNotice message={SENTENCE} title="A client could not be deleted" />)
    expect(screen.getByText(SENTENCE)).toBeInTheDocument()
    expect(screen.getByText(/A client could not be deleted/)).toBeInTheDocument()
    expect(screen.queryByText(/This tab is out of date/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reload the page/ })).toBeInTheDocument()
  })

  it('gives the client-history case its own line, not the stale-tab one', () => {
    render(
      <StaleWorkspaceNotice
        message={SENTENCE}
        title="A client could not be deleted"
        detail="Reload to put this client back. Nothing was deleted, and any change since your last save was not saved."
      />,
    )
    expect(screen.getByText('Reload to put this client back. Nothing was deleted, and any change since your last save was not saved.')).toBeInTheDocument()
    expect(screen.queryByText(/overwritten with this tab/)).not.toBeInTheDocument()
  })

  it('keeps its default title and line for the stale-tab refusal', () => {
    render(<StaleWorkspaceNotice message="Reload." />)
    expect(screen.getByText(/This tab is out of date/)).toBeInTheDocument()
    expect(screen.getByText(/overwritten with this tab/)).toBeInTheDocument()
  })

  it('has App pass that line for ClientHasHistoryApiError only', () => {
    const appSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'),
      'utf8',
    )
    const at = appSource.indexOf('if (error instanceof ClientHasHistoryApiError) {')
    const branch = appSource.slice(at, appSource.indexOf('return', at))
    expect(branch).toContain("setStaleWorkspaceDetail('Reload to put this client back. Nothing was deleted, and any change since your last save was not saved.')")
    const stale = appSource.indexOf('if (error instanceof StaleWorkspaceApiError) {')
    expect(appSource.slice(stale, at)).not.toContain('setStaleWorkspaceDetail')
  })
})
