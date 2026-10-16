import { openTradeSchema, resetAccountSchema } from '@notbroker/contracts'
import type { FastifyInstance } from 'fastify'
import type { Auth } from '../../auth/auth.ts'
import { currentUser, requireUser } from '../../auth/session.ts'
import type { BinaryService } from '../../trading/binary-service.ts'

/**
 * Aberturas por minuto, por usuário. Corta rajada de script; quem opera na mão não chega perto.
 * O teto de operações abertas ao mesmo tempo fica no BinaryService.
 */
export const TRADE_RATE_LIMIT = 30

export function registerTradingRoutes(
  app: FastifyInstance,
  auth: Auth,
  binaryService: BinaryService,
): void {
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser(auth))

    scope.get('/api/me', async (request) => currentUser(request))

    scope.get('/api/account', async (request) => binaryService.account(currentUser(request).id))

    scope.post('/api/account/reset', async (request) => {
      const { balance } = resetAccountSchema.parse(request.body)
      return binaryService.reset(currentUser(request).id, balance)
    })

    scope.get('/api/trades', async (request) => binaryService.list(currentUser(request).id))

    scope.post(
      '/api/trades',
      {
        config: {
          rateLimit: {
            max: TRADE_RATE_LIMIT,
            timeWindow: '1 minute',
            // Depois do requireUser: a chave é o usuário, não o IP.
            hook: 'preHandler',
            keyGenerator: (request) => `trades:${request.user?.id ?? request.ip}`,
          },
        },
      },
      async (request, reply) => {
        const input = openTradeSchema.parse(request.body)
        const trade = await binaryService.open(currentUser(request).id, input)
        return reply.status(201).send(trade)
      },
    )
  })
}
