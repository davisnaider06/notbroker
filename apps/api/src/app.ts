import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import type { Auth } from './auth/auth.ts'
import { registerAuthRoutes } from './auth/session.ts'
import { registerErrorHandler } from './http/error-handler.ts'
import { registerMarketRoutes } from './http/routes/market.ts'
import { registerPaymentRoutes } from './http/routes/payments.ts'
import { registerTradingRoutes } from './http/routes/trading.ts'
import { registerSecurityHeaders } from './http/security-headers.ts'
import { registerSocketGateway } from './http/socket-gateway.ts'
import { registerWebStatic } from './http/web-static.ts'
import type { FxSource } from './market-data/fx.ts'
import type { MarketDataHub } from './market-data/hub.ts'
import type { PaymentsService } from './payments/payments-service.ts'
import { AppError } from './shared/errors.ts'
import type { BinaryService } from './trading/binary-service.ts'

export interface AppDependencies {
  auth: Auth
  hub: MarketDataHub
  fx: FxSource
  binaryService: BinaryService
  payments: PaymentsService
}

export interface AppOptions {
  logger?: FastifyBaseLogger
  /** Atrás de proxy/load balancer: o IP do cliente vem do X-Forwarded-For. */
  trustProxy?: boolean
  /** Pasta do build do front. Presente em produção: a API serve a página na mesma origem. */
  webDist?: string | undefined
  /** HTTPS na frente da API: liga o HSTS. */
  hsts?: boolean
}

/** Pedidos por minuto, por IP, em qualquer rota. Folgado: o gráfico pede velas a cada troca. */
const GLOBAL_RATE_LIMIT = 600

/** Monta o servidor HTTP sem abrir porta: o mesmo app serve o main.ts e os testes (inject). */
export async function buildApp(
  deps: AppDependencies,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const trustProxy = options.trustProxy ?? false
  const app: FastifyInstance = options.logger
    ? Fastify({ loggerInstance: options.logger, trustProxy })
    : Fastify({ logger: false, trustProxy })
  app.decorateRequest('user', null)
  registerErrorHandler(app)
  registerSecurityHeaders(app, { hsts: options.hsts ?? false })
  await app.register(rateLimit, {
    max: GLOBAL_RATE_LIMIT,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) =>
      new AppError(
        429,
        'RATE_LIMITED',
        `Muitas requisições. Tente de novo em ${Math.ceil(context.ttl / 1000)} s.`,
      ),
  })
  await app.register(websocket)

  app.get('/api/health', async () => ({ status: 'ok' }))
  registerAuthRoutes(app, deps.auth)
  registerMarketRoutes(app, deps.hub, deps.fx)
  registerTradingRoutes(app, deps.auth, deps.binaryService)
  registerPaymentRoutes(app, deps.auth, deps.payments)
  registerSocketGateway(app, deps.auth, deps.hub, deps.binaryService, deps.payments)
  if (options.webDist) await registerWebStatic(app, options.webDist)

  return app
}
