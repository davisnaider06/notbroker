import { createAuthClient } from 'better-auth/react'

/** Mesma origem graças ao proxy do Vite; basePath igual ao da API. */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
})
