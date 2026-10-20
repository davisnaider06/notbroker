import { createDepositSchema, createWithdrawalSchema } from '@notbroker/contracts'
import type { FastifyInstance } from 'fastify'
import type { Auth } from '../../auth/auth.ts'
import { currentUser, requireUser } from '../../auth/session.ts'
import type { PaymentsService } from '../../payments/payments-service.ts'
import { perUser } from './trading.ts'

/** Cada depósito gera uma cobrança no gateway, que limita vendas pendentes por conta. */
export const DEPOSIT_RATE_LIMIT = 5
/** "Já paguei" consulta o gateway, que bloqueia polling. */
export const DEPOSIT_REFRESH_RATE_LIMIT = 6
export const WITHDRAWAL_RATE_LIMIT = 5
/** POSTs do gateway por minuto, por IP. Só disparam consulta, nunca crédito direto. */
const WEBHOOK_RATE_LIMIT = 120

export const WEBHOOK_PATH = '/api/webhooks/vizzionpay'

export function registerPaymentRoutes(
  app: FastifyInstance,
  auth: Auth,
  payments: PaymentsService,
): void {
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser(auth))

    scope.get('/api/payments', async (request) => payments.overview(currentUser(request).id))

    scope.post(
      '/api/deposits',
      { config: perUser('deposits', DEPOSIT_RATE_LIMIT) },
      async (request, reply) => {
        const input = createDepositSchema.parse(request.body)
        const deposit = await payments.createDeposit(currentUser(request), input)
        return reply.status(201).send(deposit)
      },
    )

    scope.post<{ Params: { id: string } }>(
      '/api/deposits/:id/refresh',
      { config: perUser('deposit-refresh', DEPOSIT_REFRESH_RATE_LIMIT) },
      async (request) => payments.refreshDeposit(currentUser(request).id, request.params.id),
    )

    scope.post(
      '/api/withdrawals',
      { config: perUser('withdrawals', WITHDRAWAL_RATE_LIMIT) },
      async (request, reply) => {
        const input = createWithdrawalSchema.parse(request.body)
        const withdrawal = await payments.createWithdrawal(currentUser(request), input, request.ip)
        return reply.status(201).send(withdrawal)
      },
    )
  })

  // Público: quem chama é o gateway. A resposta 200 só sai depois de processar; erro vira 500 e o
  // gateway tenta de novo.
  app.post(
    WEBHOOK_PATH,
    { config: { rateLimit: { max: WEBHOOK_RATE_LIMIT, timeWindow: '1 minute' } } },
    async (request) => {
      await payments.handleWebhook(request.body)
      return { received: true }
    },
  )
}
