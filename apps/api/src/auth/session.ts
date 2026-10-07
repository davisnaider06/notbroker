import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../shared/errors.ts'
import type { Auth } from './auth.ts'

export interface SessionUser {
  id: string
  email: string
  name: string
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
}

/** Repassa /api/auth/* para o handler web-standard do Better Auth. */
export function registerAuthRoutes(app: FastifyInstance, auth: Auth): void {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host}`)
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      )

      reply.status(response.status)
      for (const [key, value] of response.headers) {
        if (key !== 'set-cookie') reply.header(key, value)
      }
      const cookies = response.headers.getSetCookie()
      if (cookies.length > 0) reply.header('set-cookie', cookies)
      return reply.send(response.body ? await response.text() : null)
    },
  })
}

/** preHandler/preValidation que exige sessão válida e popula `request.user`. */
export function requireUser(auth: Auth) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
    if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'Faça login para continuar')
    request.user = { id: session.user.id, email: session.user.email, name: session.user.name }
  }
}

export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new AppError(401, 'UNAUTHENTICATED', 'Faça login para continuar')
  return request.user
}
