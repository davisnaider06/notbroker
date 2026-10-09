import { openTradeSchema } from '@notbroker/contracts'
import type { FastifyInstance } from 'fastify'
import type { Auth } from '../../auth/auth.ts'
import { currentUser, requireUser } from '../../auth/session.ts'
import type { BinaryService } from '../../trading/binary-service.ts'

export function registerTradingRoutes(
  app: FastifyInstance,
  auth: Auth,
  binaryService: BinaryService,
): void {
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser(auth))

    scope.get('/api/me', async (request) => currentUser(request))

    scope.get('/api/account', async (request) => binaryService.account(currentUser(request).id))

    scope.get('/api/trades', async (request) => binaryService.list(currentUser(request).id))

    scope.post('/api/trades', async (request, reply) => {
      const input = openTradeSchema.parse(request.body)
      const trade = await binaryService.open(currentUser(request).id, input)
      return reply.status(201).send(trade)
    })
  })
}
