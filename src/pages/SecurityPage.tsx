import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import {
  fetchTotpStatus,
  totpDisable,
  totpRegenerateBackups,
} from '../lib/api'
import { ApiError, type TotpStatus } from '../lib/types'

export function SecurityPage() {
  const { ownerMode } = useAppContext()

  // Owners manage 2FA from Settings.
  if (ownerMode) {
    return <Navigate to="/settings" replace />
  }

  return (
    <div className="content-grid settings-layout">
      <header className="client-detail-header">
        <div>
          <h1>Security</h1>
          <p className="muted-text">
            Manage two-factor authentication for your account.
          </p>
        </div>
      </header>
      <BookkeeperSecuritySection />
    </div>
  )
}

function BookkeeperSecuritySection() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<TotpStatus | null>(null)
  const [error, setError] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [regenCode, setRegenCode] = useState('')
  const [disabling, setDisabling] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null)

  useEffect(() => {
    let active = true
    fetchTotpStatus()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch(() => {
        if (active) setStatus(null)
      })
    return () => {
      active = false
    }
  }, [])

  const refresh = async () => {
    try {
      const next = await fetchTotpStatus()
      setStatus(next)
    } catch {
      setStatus(null)
    }
  }

  const handleEnable = () => {
    navigate('/two-factor/setup')
  }

  const handleDisable = async () => {
    if (!disableCode.trim() || disabling) return
    setDisabling(true)
    setError('')
    try {
      await totpDisable(disableCode.trim())
      setDisableCode('')
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable two-factor.')
    } finally {
      setDisabling(false)
    }
  }

  const handleRegenerate = async () => {
    if (!regenCode.trim() || regenerating) return
    setRegenerating(true)
    setError('')
    try {
      const result = await totpRegenerateBackups(regenCode.trim())
      setNewBackupCodes(result.backupCodes)
      setRegenCode('')
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not regenerate backup codes.')
    } finally {
      setRegenerating(false)
    }
  }

  const enabled = Boolean(status?.enabled)

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Security</p>
          <h2>Two-factor authentication</h2>
        </div>
      </div>
      <div className="form-grid">
        <p className="muted-text">
          <strong>Two-factor:</strong>{' '}
          {enabled ? (
            <span style={{ color: '#1f7d4d' }}>Enabled</span>
          ) : (
            <span>Not enabled</span>
          )}
        </p>

        {!enabled ? (
          <button className="primary-action" onClick={handleEnable} type="button">
            Enable two-factor
          </button>
        ) : (
          <>
            <p className="muted-text">
              <strong>Backup codes remaining:</strong> {status?.remainingBackupCodes ?? 0} of 8
            </p>
            <div className="form-grid two-col">
              <label className="field">
                <span>Regenerate backup codes</span>
                <input
                  className="input"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setRegenCode(event.target.value)}
                  placeholder="Current 6-digit code"
                  type="text"
                  value={regenCode}
                />
                <small className="field-helper">
                  Replaces all existing backup codes. Old codes stop working.
                </small>
                <button
                  className="auth-secondary"
                  disabled={regenerating || !regenCode.trim()}
                  onClick={handleRegenerate}
                  style={{ marginTop: 8 }}
                  type="button"
                >
                  {regenerating ? 'Regenerating…' : 'Regenerate'}
                </button>
              </label>
              <label className="field">
                <span>Disable two-factor</span>
                <input
                  className="input"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setDisableCode(event.target.value)}
                  placeholder="Current 6-digit code"
                  type="text"
                  value={disableCode}
                />
                <small className="field-helper">
                  You can re-enable two-factor at any time.
                </small>
                <button
                  className="team-danger-button"
                  disabled={disabling || !disableCode.trim()}
                  onClick={handleDisable}
                  style={{ marginTop: 8 }}
                  type="button"
                >
                  {disabling ? 'Disabling…' : 'Disable'}
                </button>
              </label>
            </div>
            {newBackupCodes ? (
              <div>
                <p className="muted-text">
                  <strong>New backup codes — save these now.</strong> The old codes no longer work.
                </p>
                <ul
                  style={{
                    background: '#f6f5f1',
                    border: '1px solid #e6e2dc',
                    borderRadius: 10,
                    padding: '12px 18px',
                    margin: '4px 0',
                    listStyle: 'none',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  {newBackupCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
                <button
                  className="auth-secondary"
                  onClick={() => setNewBackupCodes(null)}
                  type="button"
                >
                  Done
                </button>
              </div>
            ) : null}
          </>
        )}

        {error ? <p className="auth-error">{error}</p> : null}
      </div>
    </section>
  )
}
