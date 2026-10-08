import { pino } from 'pino'
import { buildApp } from './app.ts'
import { createAuth } from './auth/auth.ts'
import { loadEnv } from './config/env.ts'
import { openDatabase } from './db/client.ts'
import { CATALOG } from './market-data/catalog.ts'
import { YahooFx } from './market-data/fx.ts'
import { MarketDataHub } from './market-data/hub.ts'
import { AlpacaProvider } from './market-data/providers/alpaca.ts'
import { BinanceProvider } from './market-data/providers/binance.ts'
import { YahooProvider } from './market-data/providers/yahoo.ts'
import { syncCatalog } from './trading/accounts.ts'
import { OrderService } from './trading/order-service.ts'

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
const hub = new MarketDataHub({
  CRYPTO: new BinanceProvider(logger),
  B3: yahoo,
  US: alpaca ?? yahoo,
})
logger.info(`ações dos EUA via ${alpaca ? 'Alpaca (WebSocket)' : 'Yahoo (polling)'}`)

const auth = createAuth(database.db, env)
const orderService = new OrderService(database.db, hub, logger)
const app = await buildApp({ auth, hub, fx: new YahooFx(logger), orderService }, { logger })

await orderService.start()
hub.start(CATALOG)
await app.listen({ port: env.PORT, host: '0.0.0.0' })

const shutdown = async () => {
  hub.stop()
  await app.close()
  await database.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
