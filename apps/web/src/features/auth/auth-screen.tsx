import { type FormEvent, useState } from 'react'
import { authClient } from '../../lib/auth-client.ts'

type Mode = 'sign-in' | 'sign-up'

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('sign-in')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email'))
    const password = String(form.get('password'))

    setSubmitting(true)
    setError(null)
    const result =
      mode === 'sign-up'
        ? await authClient.signUp.email({ email, password, name: String(form.get('name')) })
        : await authClient.signIn.email({ email, password })
    setSubmitting(false)
    if (result.error) setError(result.error.message ?? 'Não foi possível entrar')
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1 className="brand">NotBroker</h1>
        <p className="muted">
          Casa de opções binárias simulada. Dinheiro de mentira, cotação de verdade.
        </p>

        {mode === 'sign-up' && (
          <label>
            Nome
            <input name="name" required autoComplete="name" />
          </label>
        )}
        <label>
          E-mail
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Senha
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" className="primary" disabled={submitting}>
          {mode === 'sign-up' ? 'Criar conta' : 'Entrar'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'sign-up' ? 'sign-in' : 'sign-up')
            setError(null)
          }}
        >
          {mode === 'sign-up' ? 'Já tenho conta' : 'Criar conta nova'}
        </button>
      </form>
    </main>
  )
}
