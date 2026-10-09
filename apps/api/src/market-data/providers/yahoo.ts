import type { CandleDto, CandleInterval } from '@notbroker/contracts'
import { z } from 'zod'
import type { Instrument } from '../catalog.ts'
import { fetchJson, type Logger, type MarketDataProvider, type TickListener } from '../provider.ts'

/**
 * Endpoint de gráfico do Yahoo Finance: grátis e sem chave, mas NÃO oficial.
 * Cotação da B3 vem com atraso de ~15 min. Pode mudar sem aviso; por isso fica isolado aqui.
 */
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'
/**
 * Sem keep-alive: entre um polling e outro (15 s) o Yahoo derruba a conexão ociosa sem avisar, e o
 * fetch seguinte reaproveita o socket morto e fica pendurado até o timeout (~1 em 4 requisições).
 * Conexão nova custa ~1 s de TLS, irrelevante para polling.
 */
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (NotBroker paper trading)', Connection: 'close' }

const RANGES: Record<CandleInterval, { interval: string; range: string }> = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '1mo' },
  '15m': { interval: '15m', range: '1mo' },
  '1h': { interval: '60m', range: '6mo' },
  '1d': { interval: '1d', range: '2y' },
}

const nullableNumbers = z.array(z.number().nullable())

const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({ regularMarketPrice: z.number(), regularMarketTime: z.number() }),
          timestamp: z.array(z.number()).optional(),
          indicators: z.object({
            quote: z.array(
              z.object({
                open: nullableNumbers,
                high: nullableNumbers,
                low: nullableNumbers,
                close: nullableNumbers,
                volume: nullableNumbers,
              }),
            ),
          }),
        }),
      )
      .min(1),
  }),
})

/** Yahoo serializa candles como float32 (48.099998...). 4 casas bastam para qualquer ação. */
function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function yahooSymbol(instrument: Instrument): string {
  return instrument.market === 'B3' ? `${instrument.symbol}.SA` : instrument.symbol
}

export function parseYahooChart(payload: unknown): {
  price: number
  time: number
  candles: CandleDto[]
} {
  const [result] = chartSchema.parse(payload).chart.result
  if (!result) throw new Error('resposta do Yahoo sem resultado')
  const quote = result.indicators.quote[0]
  const candles: CandleDto[] = []
  for (const [index, time] of (result.timestamp ?? []).entries()) {
    const open = quote?.open[index]
    const high = quote?.high[index]
    const low = quote?.low[index]
    const close = quote?.close[index]
    // Yahoo devolve null em minutos sem negócio; esses buracos são descartados.
    if (open == null || high == null || low == null || close == null) continue
    candles.push({
      time,
      open: roundPrice(open),
      high: roundPrice(high),
      low: roundPrice(low),
      close: roundPrice(close),
      volume: quote?.volume[index] ?? 0,
    })
  }
  return {
    price: result.meta.regularMarketPrice,
    time: result.meta.regularMarketTime * 1000,
    candles,
  }
}

/** Último preço de qualquer símbolo do Yahoo (câmbio usa "EURUSD=X", "BRL=X"...). */
export async function fetchYahooPrice(symbol: string): Promise<number> {
  const url = `${CHART_URL}/${encodeURIComponent(symbol)}?interval=1d&range=1d`
  return parseYahooChart(await fetchJson('yahoo', url, { headers: HEADERS })).price
}

export class YahooProvider implements MarketDataProvider {
  readonly name = 'yahoo'
  readonly #logger: Logger
  readonly #pollMs: number
  readonly #lastSeen = new Map<string, string>()
  #timer: NodeJS.Timeout | undefined

  constructor(logger: Logger, pollMs: number) {
    this.#logger = logger
    this.#pollMs = pollMs
  }

  start(instruments: readonly Instrument[], onTick: TickListener): void {
    if (instruments.length === 0) return
    const poll = async () => {
      // Sequencial de propósito: endpoint não oficial, melhor não disparar rajadas.
      for (const instrument of instruments) {
        try {
          const { price, time } = parseYahooChart(await this.#fetchChart(instrument, '1d', '1d'))
          const signature = `${price}@${time}`
          if (this.#lastSeen.get(instrument.symbol) === signature) continue
          this.#lastSeen.set(instrument.symbol, signature)
          onTick({ symbol: instrument.symbol, price: String(price), time })
        } catch (error) {
          this.#logger.warn({ err: error, symbol: instrument.symbol }, '[yahoo] falha no polling')
        }
      }
      this.#timer = setTimeout(poll, this.#pollMs)
    }
    void poll()
  }

  async candles(instrument: Instrument, interval: CandleInterval): Promise<CandleDto[]> {
    const { interval: yahooInterval, range } = RANGES[interval]
    return parseYahooChart(await this.#fetchChart(instrument, yahooInterval, range)).candles
  }

  stop(): void {
    clearTimeout(this.#timer)
  }

  #fetchChart(instrument: Instrument, interval: string, range: string): Promise<unknown> {
    const url = `${CHART_URL}/${yahooSymbol(instrument)}?interval=${interval}&range=${range}`
    return fetchJson(this.name, url, { headers: HEADERS })
  }
}
