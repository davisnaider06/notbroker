import type { CandleDto, CandleInterval, Market } from '@notbroker/contracts'
import { findInstrument, type Instrument } from './catalog.ts'
import {
  type Logger,
  type MarketDataProvider,
  type Tick,
  type TickListener,
  UpstreamError,
} from './provider.ts'

const CANDLE_CACHE_MS = 15_000

/**
 * Ponto único de preço do sistema. Recebe ticks de todos os provedores, guarda o último preço de
 * cada ativo e repassa para quem escuta (casa de binárias e gateway WebSocket).
 */
export class MarketDataHub {
  readonly #routes: Record<Market, MarketDataProvider>
  readonly #lastTicks = new Map<string, Tick>()
  readonly #listeners = new Set<TickListener>()
  readonly #candleCache = new Map<string, { expiresAt: number; candles: Promise<CandleDto[]> }>()
  /** Último histórico que chegou inteiro, por ativo e intervalo: resposta de reserva se o provedor cair. */
  readonly #lastGoodCandles = new Map<string, CandleDto[]>()
  readonly #logger: Logger | undefined

  constructor(routes: Record<Market, MarketDataProvider>, logger?: Logger) {
    this.#routes = routes
    this.#logger = logger
  }

  start(catalog: readonly Instrument[]): void {
    // Um provedor pode atender mais de um mercado (Yahoo cobre B3 e, sem Alpaca, EUA).
    const byProvider = new Map<MarketDataProvider, Instrument[]>()
    for (const instrument of catalog) {
      const provider = this.#routes[instrument.market]
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), instrument])
    }
    for (const [provider, instruments] of byProvider) {
      provider.start(instruments, (tick) => this.publish(tick))
    }
  }

  /** Entrada de ticks. Pública para testes e para injetar preço manualmente. */
  publish(tick: Tick): void {
    if (!findInstrument(tick.symbol)) return
    const previous = this.#lastTicks.get(tick.symbol)
    if (previous && previous.time > tick.time) return
    this.#lastTicks.set(tick.symbol, tick)
    for (const listener of this.#listeners) listener(tick)
  }

  onTick(listener: TickListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Binária só abre em mercado cuja fonte é tempo real: com atraso, o resultado já é conhecido. */
  isRealtime(market: Market): boolean {
    return this.#routes[market].realtime
  }

  lastPrice(symbol: string): string | undefined {
    return this.#lastTicks.get(symbol)?.price
  }

  lastTick(symbol: string): Tick | undefined {
    return this.#lastTicks.get(symbol)
  }

  /** Primeiro negócio do ativo que chegar a partir de agora; undefined se nada vier no prazo. */
  nextTick(symbol: string, timeoutMs: number): Promise<Tick | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        stop()
        resolve(undefined)
      }, timeoutMs)
      const stop = this.onTick((tick) => {
        if (tick.symbol !== symbol) return
        clearTimeout(timer)
        stop()
        resolve(tick)
      })
    })
  }

  candles(instrument: Instrument, interval: CandleInterval): Promise<CandleDto[]> {
    const key = `${instrument.symbol}:${interval}`
    const cached = this.#candleCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.candles

    const provider = this.#routes[instrument.market]
    const candles = provider.candles(instrument, interval).then(
      (fresh) => {
        this.#lastGoodCandles.set(key, fresh)
        return fresh
      },
      (error: unknown) => {
        this.#candleCache.delete(key)
        // Histórico de minutos atrás é melhor que gráfico vazio: os ticks ao vivo continuam dali.
        const stale = this.#lastGoodCandles.get(key)
        this.#logger?.warn(
          { err: error, key, servedStale: stale !== undefined },
          'falha ao buscar histórico de velas',
        )
        if (stale) return stale
        // Formato inesperado (zod) também é problema do provedor, não pedido inválido do cliente.
        throw error instanceof UpstreamError
          ? error
          : new UpstreamError(provider.name, String(error))
      },
    )
    this.#candleCache.set(key, { expiresAt: Date.now() + CANDLE_CACHE_MS, candles })
    return candles
  }

  stop(): void {
    for (const provider of new Set(Object.values(this.#routes))) provider.stop()
    this.#listeners.clear()
  }
}
