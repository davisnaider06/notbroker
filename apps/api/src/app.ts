import websocket from '@fastify/websocket'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import type { Auth } from './auth/auth.ts'
import { registerAuthRoutes } from './auth/session.ts'
import { registerErrorHandler } from './http/error-handler.ts'
import { registerMarketRoutes } from './http/routes/market.ts'
import { registerTradingRoutes } from './http/routes/trading.ts'
import { registerSocketGateway } from './http/socket-gateway.ts'
import type { FxSource } from './market-data/fx.ts'
import type { MarketDataHub } from './market-data/hub.ts'
import type { BinaryService } from './trading/binary-service.ts'

export interface AppDependencies {
  auth: Auth
  hub: MarketDataHub
  fx: FxSource
  binaryService: BinaryService
}

/** Monta o servidor HTTP sem abrir porta: o mesmo app serve o main.ts e os testes (inject). */
export async function buildApp(
  deps: AppDependencies,
  options: { logger?: FastifyBaseLogger } = {},
): Promise<FastifyInstance> {
  const app: FastifyInstance = options.logger
    ? Fastify({ loggerInstance: options.logger })
    : Fastify({ logger: false })
  app.decorateRequest('user', null)
  registerErrorHandler(app)
  await app.register(websocket)

  app.get('/api/health', async () => ({ status: 'ok' }))
  registerAuthRoutes(app, deps.auth)
  registerMarketRoutes(app, deps.hub, deps.fx)
  registerTradingRoutes(app, deps.auth, deps.binaryService)
  registerSocketGateway(app, deps.auth, deps.hub, deps.binaryService)

  return app
}
