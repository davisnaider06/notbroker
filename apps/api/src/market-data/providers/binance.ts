import type { CandleDto, CandleInterval } from '@notbroker/contracts'
import { z } from 'zod'
import type { Instrument } from '../catalog.ts'
import {
  fetchJson,
  type Logger,
  type MarketDataProvider,
  ReconnectingSocket,
  type Tick,
  type TickListener,
} from '../provider.ts'

/** Endpoints públicos só de market data da Binance: sem chave, sem bloqueio de região. */
const REST_URL = 'https://data-api.binance.vision/api/v3'
const STREAM_URL = 'wss://data-stream.binance.vision/stream'

const aggTradeEnvelope = z.object({
  data: z.object({ e: z.literal('aggTrade'), s: z.string(), p: z.string(), T: z.number() }),
})

const klinesSchema = z.array(
  z
    .tuple([z.number(), z.string(), z.string(), z.string(), z.string(), z.string()])
    .rest(z.unknown()),
)

export function parseBinanceMessage(raw: string): Tick | undefined {
  const parsed = aggTradeEnvelope.safeParse(JSON.parse(raw))
  if (!parsed.success) return undefined
  const { s, p, T } = parsed.data.data
  return { symbol: s, price: p, time: T }
}

export function parseBinanceKlines(payload: unknown): CandleDto[] {
  return klinesSchema.parse(payload).map(([openTime, open, high, low, close, volume]) => ({
    time: Math.floor(openTime / 1000),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }))
}

export class BinanceProvider implements MarketDataProvider {
  readonly name = 'binance'
  readonly #logger: Logger
  #socket: ReconnectingSocket | undefined

  constructor(logger: Logger) {
    this.#logger = logger
  }

  start(instruments: readonly Instrument[], onTick: TickListener): void {
    if (instruments.length === 0) return
    const streams = instruments.map((i) => `${i.symbol.toLowerCase()}@aggTrade`).join('/')
    this.#socket = new ReconnectingSocket({
      name: this.name,
      url: `${STREAM_URL}?streams=${streams}`,
      logger: this.#logger,
      onOpen: () => {},
      onMessage: (data) => {
        const tick = parseBinanceMessage(data)
        if (tick) onTick(tick)
      },
    })
    this.#socket.connect()
  }

  async candles(instrument: Instrument, interval: CandleInterval): Promise<CandleDto[]> {
    const url = `${REST_URL}/klines?symbol=${instrument.symbol}&interval=${interval}&limit=500`
    return parseBinanceKlines(await fetchJson(this.name, url))
  }

  stop(): void {
    this.#socket?.close()
  }
}
