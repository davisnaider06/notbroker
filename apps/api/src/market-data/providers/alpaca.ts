import type { CandleDto, CandleInterval } from '@b-hook/contracts'
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

/**
 * Alpaca, plano Basic (grátis, conta paper sem depósito): WebSocket real-time do feed IEX,
 * até 30 símbolos e uma conexão simultânea por chave.
 */
const STREAM_URL = 'wss://stream.data.alpaca.markets/v2/iex'
const REST_URL = 'https://data.alpaca.markets/v2/stocks'

const DAY_MS = 86_400_000
const BARS: Record<CandleInterval, { timeframe: string; lookbackMs: number }> = {
  '1m': { timeframe: '1Min', lookbackMs: 5 * DAY_MS },
  '5m': { timeframe: '5Min', lookbackMs: 30 * DAY_MS },
  '15m': { timeframe: '15Min', lookbackMs: 60 * DAY_MS },
  '1h': { timeframe: '1Hour', lookbackMs: 180 * DAY_MS },
  '1d': { timeframe: '1Day', lookbackMs: 730 * DAY_MS },
}

const streamMessageSchema = z.discriminatedUnion('T', [
  z.object({ T: z.literal('t'), S: z.string(), p: z.number(), t: z.string() }),
  z.object({ T: z.literal('success'), msg: z.string() }),
  z.object({ T: z.literal('error'), code: z.number(), msg: z.string() }),
  z.object({ T: z.literal('subscription') }),
])

export type AlpacaEvent =
  | { kind: 'tick'; tick: Tick }
  | { kind: 'connected' }
  | { kind: 'authenticated' }
  | { kind: 'error'; message: string }

/** A Alpaca manda arrays de eventos por frame; tipos que não usamos (quotes, bars) são ignorados. */
export function parseAlpacaFrame(raw: string): AlpacaEvent[] {
  const frame: unknown = JSON.parse(raw)
  if (!Array.isArray(frame)) return []
  const events: AlpacaEvent[] = []
  for (const item of frame) {
    const parsed = streamMessageSchema.safeParse(item)
    if (!parsed.success) continue
    const message = parsed.data
    if (message.T === 't') {
      events.push({
        kind: 'tick',
        tick: { symbol: message.S, price: String(message.p), time: Date.parse(message.t) },
      })
    } else if (message.T === 'success' && message.msg === 'connected') {
      events.push({ kind: 'connected' })
    } else if (message.T === 'success' && message.msg === 'authenticated') {
      events.push({ kind: 'authenticated' })
    } else if (message.T === 'error') {
      events.push({ kind: 'error', message: `${message.code} ${message.msg}` })
    }
  }
  return events
}

const barsSchema = z.object({
  bars: z
    .array(
      z.object({
        t: z.string(),
        o: z.number(),
        h: z.number(),
        l: z.number(),
        c: z.number(),
        v: z.number(),
      }),
    )
    .nullable(),
})

const snapshotsSchema = z.record(
  z.string(),
  z.object({ latestTrade: z.object({ p: z.number(), t: z.string() }).nullable() }),
)

export function parseAlpacaBars(payload: unknown): CandleDto[] {
  const bars = barsSchema.parse(payload).bars ?? []
  // Pedimos sort=desc para pegar os mais recentes; o gráfico precisa em ordem crescente.
  return bars
    .map((bar) => ({
      time: Math.floor(Date.parse(bar.t) / 1000),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }))
    .reverse()
}

export class AlpacaProvider implements MarketDataProvider {
  readonly name = 'alpaca'
  readonly #logger: Logger
  readonly #headers: Record<string, string>
  readonly #credentials: { key: string; secret: string }
  #socket: ReconnectingSocket | undefined

  constructor(logger: Logger, credentials: { key: string; secret: string }) {
    this.#logger = logger
    this.#credentials = credentials
    this.#headers = {
      'APCA-API-KEY-ID': credentials.key,
      'APCA-API-SECRET-KEY': credentials.secret,
    }
  }

  start(instruments: readonly Instrument[], onTick: TickListener): void {
    if (instruments.length === 0) return
    const symbols = instruments.map((instrument) => instrument.symbol)

    // Fora do pregão não há negócios no stream; o snapshot garante um último preço desde o boot.
    void this.#seedLastTrades(symbols, onTick)

    this.#socket = new ReconnectingSocket({
      name: this.name,
      url: STREAM_URL,
      logger: this.#logger,
      onOpen: () => {},
      onMessage: (data, socket) => {
        for (const event of parseAlpacaFrame(data)) {
          if (event.kind === 'tick') onTick(event.tick)
          else if (event.kind === 'connected') {
            const { key, secret } = this.#credentials
            socket.send(JSON.stringify({ action: 'auth', key, secret }))
          } else if (event.kind === 'authenticated') {
            socket.send(JSON.stringify({ action: 'subscribe', trades: symbols }))
          } else {
            this.#logger.error(`[alpaca] ${event.message}`)
          }
        }
      },
    })
    this.#socket.connect()
  }

  async candles(instrument: Instrument, interval: CandleInterval): Promise<CandleDto[]> {
    const { timeframe, lookbackMs } = BARS[interval]
    const start = new Date(Date.now() - lookbackMs).toISOString()
    const params = new URLSearchParams({
      timeframe,
      start,
      feed: 'iex',
      limit: '1000',
      sort: 'desc',
    })
    const url = `${REST_URL}/${instrument.symbol}/bars?${params}`
    return parseAlpacaBars(await fetchJson(this.name, url, { headers: this.#headers }))
  }

  stop(): void {
    this.#socket?.close()
  }

  async #seedLastTrades(symbols: string[], onTick: TickListener): Promise<void> {
    try {
      const params = new URLSearchParams({ symbols: symbols.join(','), feed: 'iex' })
      const url = `${REST_URL}/snapshots?${params}`
      const snapshots = snapshotsSchema.parse(
        await fetchJson(this.name, url, { headers: this.#headers }),
      )
      for (const [symbol, snapshot] of Object.entries(snapshots)) {
        if (!snapshot.latestTrade) continue
        const { p, t } = snapshot.latestTrade
        onTick({ symbol, price: String(p), time: Date.parse(t) })
      }
    } catch (error) {
      this.#logger.warn({ err: error }, '[alpaca] falha ao buscar snapshots')
    }
  }
}
