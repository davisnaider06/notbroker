import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerErrorHandler } from './error-handler.ts'
import { registerSecurityHeaders } from './security-headers.ts'
import { registerWebStatic } from './web-static.ts'

let dist: string
let app: FastifyInstance

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'notbroker-dist-'))
  mkdirSync(join(dist, 'assets'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>NotBroker</title>')
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)')

  app = Fastify()
  registerErrorHandler(app)
  registerSecurityHeaders(app, { hsts: true })
  app.get('/api/health', async () => ({ status: 'ok' }))
  await registerWebStatic(app, dist)
})

afterAll(async () => {
  await app.close()
  rmSync(dist, { recursive: true, force: true })
})

describe('API servindo o build do front', () => {
  it('serve o index.html na raiz e em rota do React', async () => {
    for (const url of ['/', '/trade/BTCUSDT']) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('NotBroker')
      expect(response.headers['cache-control']).toBe('no-cache')
    }
  })

  it('assets com hash ficam em cache para sempre', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('immutable')
  })

  it('rota de API inexistente continua 404 em JSON, sem cair no index.html', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nao-existe' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('a página sai com CSP e HSTS', async () => {
    const response = await app.inject({ method: 'GET', url: '/' })
    expect(response.headers['content-security-policy']).toContain("script-src 'self'")
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('recusa subir sem build', async () => {
    await expect(registerWebStatic(Fastify(), join(dist, 'nada'))).rejects.toThrow('npm run build')
  })
})
