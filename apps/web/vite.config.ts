import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_URL = process.env.API_URL ?? 'http://localhost:3333'

/**
 * Em dev o Vite faz proxy de /api e /ws para a API: navegador e API ficam na mesma origem,
 * então o cookie de sessão funciona sem CORS.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': API_URL,
      '/ws': { target: API_URL.replace(/^http/, 'ws'), ws: true },
    },
  },
})
