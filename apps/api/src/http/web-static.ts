import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../shared/errors.ts'

/**
 * Em produção a API serve o build do front: página e API na mesma origem, então o cookie de
 * sessão e o WebSocket funcionam como no proxy do Vite em dev, sem CORS.
 */
export async function registerWebStatic(app: FastifyInstance, webDist: string): Promise<void> {
  if (!existsSync(join(webDist, 'index.html'))) {
    throw new Error(`Build do front não encontrado em ${webDist}. Rode "npm run build" antes.`)
  }

  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
    setHeaders: (reply, path) => {
      // Arquivos de /assets têm hash no nome: podem ficar em cache para sempre.
      const immutable = /[\\/]assets[\\/]/.test(path)
      reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    },
  })

  // SPA: qualquer GET fora de /api e /ws devolve o index.html e o React decide a tela.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (request.method !== 'GET' || path.startsWith('/api/') || path === '/ws') {
      throw new AppError(404, 'NOT_FOUND', `Rota ${request.method} ${path} não existe`)
    }
    return reply.header('cache-control', 'no-cache').sendFile('index.html')
  })
}
