import { openTradeSchema, resetAccountSchema } from '@notbroker/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Auth } from '../../auth/auth.ts'
import { currentUser, requireUser } from '../../auth/session.ts'
import type { BinaryService } from '../../trading/binary-service.ts'

/**
 * Aberturas por minuto, por usuário. Corta rajada de script; quem opera na mão não chega perto.
 * O teto de operações abertas ao mesmo tempo fica no BinaryService.
 */
export const TRADE_RATE_LIMIT = 30
/** Bancas novas por minuto, por usuário: cada uma regrava a carteira dentro de uma transação. */
export const RESET_RATE_LIMIT = 5

/** Limite por usuário; roda depois do requireUser, então a chave é o usuário, não o IP. */
const perUser = (name: string, max: number) => ({
  rateLimit: {
    max,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest) => `${name}:${request.user?.id ?? request.ip}`,
  },
})

export function registerTradingRoutes(
  app: FastifyInstance,
  auth: Auth,
  binaryService: BinaryService,
): void {
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser(auth))

    scope.get('/api/me', async (request) => currentUser(request))

    scope.get('/api/account', async (request) => binaryService.account(currentUser(request).id))

    scope.post(
      '/api/account/reset',
      { config: perUser('reset', RESET_RATE_LIMIT) },
      async (request) => {
        const { balance } = resetAccountSchema.parse(request.body)
        return binaryService.reset(currentUser(request).id, balance)
      },
    )

    scope.get('/api/trades', async (request) => binaryService.list(currentUser(request).id))

    scope.post(
      '/api/trades',
      { config: perUser('trades', TRADE_RATE_LIMIT) },
      async (request, reply) => {
        const input = openTradeSchema.parse(request.body)
        const trade = await binaryService.open(currentUser(request).id, input)
        return reply.status(201).send(trade)
      },
    )
  })
}
