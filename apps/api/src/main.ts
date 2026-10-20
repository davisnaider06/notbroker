import { resolve } from 'node:path'
import { pino } from 'pino'
import { buildApp } from './app.ts'
import { createAuth } from './auth/auth.ts'
import { loadEnv } from './config/env.ts'
import { openDatabase } from './db/client.ts'
import { WEBHOOK_PATH } from './http/routes/payments.ts'
import { CATALOG } from './market-data/catalog.ts'
import { YahooFx } from './market-data/fx.ts'
import { MarketDataHub } from './market-data/hub.ts'
import { AlpacaProvider } from './market-data/providers/alpaca.ts'
import { BinanceProvider } from './market-data/providers/binance.ts'
import { YahooProvider } from './market-data/providers/yahoo.ts'
import { PaymentsService } from './payments/payments-service.ts'
import { VizzionPayGateway } from './payments/vizzionpay.ts'
import { syncCatalog } from './trading/accounts.ts'
import { BinaryService } from './trading/binary-service.ts'

const env = loadEnv()
const logger = pino(
  env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } }
    : {},
)

const database = await openDatabase({ url: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR })
await syncCatalog(database.db)

const alpaca =
  env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY
    ? new AlpacaProvider(logger, { key: env.ALPACA_KEY_ID, secret: env.ALPACA_SECRET_KEY })
    : undefined
const yahoo = new YahooProvider(logger, env.YAHOO_POLL_MS)
const hub = new MarketDataHub(
  {
    CRYPTO: new BinanceProvider(logger),
    B3: yahoo,
    US: alpaca ?? yahoo,
  },
  logger,
)
logger.info(`ações dos EUA via ${alpaca ? 'Alpaca (WebSocket)' : 'Yahoo (polling)'}`)

const auth = createAuth(database.db, env)
const binaryService = new BinaryService(database.db, hub, logger)
const gateway =
  env.VIZZIONPAY_PUBLIC_KEY && env.VIZZIONPAY_SECRET_KEY
    ? new VizzionPayGateway({
        baseUrl: env.VIZZIONPAY_URL,
        publicKey: env.VIZZIONPAY_PUBLIC_KEY,
        secretKey: env.VIZZIONPAY_SECRET_KEY,
      })
    : undefined
const publicUrl = new URL(env.PUBLIC_URL ?? env.BETTER_AUTH_URL)
// O gateway não alcança localhost (e recusa a URL): em dev, só a consulta atualiza o status.
const callbackUrl = ['localhost', '127.0.0.1'].includes(publicUrl.hostname)
  ? undefined
  : new URL(WEBHOOK_PATH, publicUrl.origin).toString()
const payments = new PaymentsService(database.db, gateway, logger, { callbackUrl })
logger.info(
  gateway
    ? `conta real ligada (VizzionPay), webhook ${callbackUrl ?? 'desligado em localhost'}`
    : 'conta real desligada: sem chaves da VizzionPay',
)
const production = env.NODE_ENV === 'production'
const app = await buildApp(
  { auth, hub, fx: new YahooFx(logger), binaryService, payments },
  {
    logger,
    trustProxy: env.TRUST_PROXY,
    // Em produção a API serve o front; em dev quem serve é o Vite, com proxy para cá.
    webDist:
      env.WEB_DIST ?? (production ? resolve(import.meta.dirname, '../../web/dist') : undefined),
    hsts: production && new URL(env.BETTER_AUTH_URL).protocol === 'https:',
  },
)

await binaryService.start()
payments.start()
hub.start(CATALOG)
await app.listen({ port: env.PORT, host: '0.0.0.0' })

const shutdown = async () => {
  binaryService.stop()
  payments.stop()
  hub.stop()
  await app.close()
  await database.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
