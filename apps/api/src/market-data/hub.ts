import type { CandleDto, CandleInterval, Market } from '@b-hook/contracts'
import { findInstrument, type Instrument } from './catalog.ts'
import type { MarketDataProvider, Tick, TickListener } from './provider.ts'

const CANDLE_CACHE_MS = 15_000

/**
 * Ponto único de preço do sistema. Recebe ticks de todos os provedores, guarda o último preço de
 * cada ativo e repassa para quem escuta (matching engine e gateway WebSocket).
 */
export class MarketDataHub {
  readonly #routes: Record<Market, MarketDataProvider>
  readonly #lastTicks = new Map<string, Tick>()
  readonly #listeners = new Set<TickListener>()
  readonly #candleCache = new Map<string, { expiresAt: number; candles: Promise<CandleDto[]> }>()

  constructor(routes: Record<Market, MarketDataProvider>) {
    this.#routes = routes
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

  lastPrice(symbol: string): string | undefined {
    return this.#lastTicks.get(symbol)?.price
  }

  lastTick(symbol: string): Tick | undefined {
    return this.#lastTicks.get(symbol)
  }

  candles(instrument: Instrument, interval: CandleInterval): Promise<CandleDto[]> {
    const key = `${instrument.symbol}:${interval}`
    const cached = this.#candleCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.candles

    const candles = this.#routes[instrument.market].candles(instrument, interval)
    this.#candleCache.set(key, { expiresAt: Date.now() + CANDLE_CACHE_MS, candles })
    candles.catch(() => this.#candleCache.delete(key))
    return candles
  }

  stop(): void {
    for (const provider of new Set(Object.values(this.#routes))) provider.stop()
    this.#listeners.clear()
  }
}
