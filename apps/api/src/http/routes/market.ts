import { candlesQuerySchema, type FxRatesDto, type InstrumentDto } from '@b-hook/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CATALOG, findInstrument } from '../../market-data/catalog.ts'
import type { FxSource } from '../../market-data/fx.ts'
import type { MarketDataHub } from '../../market-data/hub.ts'
import { AppError } from '../../shared/errors.ts'

const symbolParams = z.object({ symbol: z.string().toUpperCase() })

/** Dados de mercado são públicos: dá para ver o gráfico antes de criar conta. */
export function registerMarketRoutes(app: FastifyInstance, hub: MarketDataHub, fx: FxSource): void {
  app.get('/api/fx', (): Promise<FxRatesDto> => fx.rates())

  app.get(
    '/api/instruments',
    async (): Promise<InstrumentDto[]> =>
      CATALOG.map((instrument) => ({
        symbol: instrument.symbol,
        name: instrument.name,
        market: instrument.market,
        currency: instrument.currency,
        quantityDecimals: instrument.quantityDecimals,
        lastPrice: hub.lastPrice(instrument.symbol) ?? null,
      })),
  )

  app.get('/api/instruments/:symbol/candles', async (request) => {
    const { symbol } = symbolParams.parse(request.params)
    const { interval } = candlesQuerySchema.parse(request.query)
    const instrument = findInstrument(symbol)
    if (!instrument) throw new AppError(404, 'UNKNOWN_SYMBOL', `Ativo ${symbol} não existe`)
    return hub.candles(instrument, interval)
  })
}
