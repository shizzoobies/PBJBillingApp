import { useState, type FormEvent } from 'react'
import type { LoginOption } from '../lib/types'

export function LoginScreen({
  error,
  loading = false,
  loginOptions,
  onLogin,
}: {
  error?: string
  loading?: boolean
  loginOptions: LoginOption[]
  onLogin: (userId: string, password: string) => Promise<void>
}) {
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('pbj-demo')
  const selectedUserId = userId || loginOptions[0]?.id || ''

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedUserId || !password || loading) {
      return
    }

    await onLogin(selectedUserId, password)
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyeline">PB&amp;J Strategic Accounting</p>
        <h1>Sign in to the workspace</h1>
        <p className="auth-copy">
          This prototype now uses server-backed sessions. Use the temporary password{' '}
          <strong>`pbj-demo`</strong> for any seeded account unless `AUTH_DEMO_PASSWORD` has been
          changed on the server.
        </p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Account</span>
            <select
              className="input"
              onChange={(event) => setUserId(event.target.value)}
              value={selectedUserId}
            >
              {loginOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.staffRole})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <button
            className="primary-action auth-submit"
            disabled={loading || loginOptions.length === 0}
            type="submit"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}
