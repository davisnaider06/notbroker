import type { FastifyError, FastifyInstance } from 'fastify'
import { ZodError, z } from 'zod'
import { UpstreamError } from '../market-data/provider.ts'
import { AppError } from '../shared/errors.ts'

/** Formato único de erro da API: { error: { code, message, details? } }. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION', message: z.prettifyError(error), details: error.issues },
      })
    }
    if (error instanceof UpstreamError) {
      request.log.warn({ err: error }, 'falha no provedor de mercado')
      return reply
        .status(502)
        .send({ error: { code: 'UPSTREAM', message: 'Provedor de cotações indisponível' } })
    }
    if ('statusCode' in error && error.statusCode && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code ?? 'BAD_REQUEST', message: error.message } })
    }
    request.log.error({ err: error }, 'erro não tratado')
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Erro interno' } })
  })
}
