import type { ClientMessage, ServerMessage, TradeDto } from '@notbroker/contracts'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

export interface LivePrice {
  price: number
  time: number
  /** Abertura, máxima e mínima dos negócios desde a última atualização (~250 ms). */
  open: number
  high: number
  low: number
  /** Direção em relação ao tick anterior, para o "flash" verde/vermelho. */
  direction: 'up' | 'down' | 'flat'
}

type Listener = () => void
type TradeListener = (trade: TradeDto) => void

/**
 * Uma conexão WebSocket por aba. Componentes assinam símbolos com contagem de referência;
 * a conexão reenvia as assinaturas sozinha depois de cair.
 */
class MarketStream {
  #socket: WebSocket | undefined
  #retry = 0
  #active = false
  readonly #refCounts = new Map<string, number>()
  readonly #prices = new Map<string, LivePrice>()
  readonly #priceListeners = new Map<string, Set<Listener>>()
  readonly #tradeListeners = new Set<TradeListener>()

  connect(): void {
    if (this.#active) return
    this.#active = true
    this.#open()
  }

  disconnect(): void {
    this.#active = false
    this.#socket?.close()
    this.#socket = undefined
  }

  subscribe(symbols: readonly string[]): () => void {
    const fresh = symbols.filter((symbol) => {
      const count = this.#refCounts.get(symbol) ?? 0
      this.#refCounts.set(symbol, count + 1)
      return count === 0
    })
    if (fresh.length > 0) this.#send({ type: 'subscribe', symbols: fresh })

    return () => {
      const stale = symbols.filter((symbol) => {
        const count = (this.#refCounts.get(symbol) ?? 1) - 1
        if (count === 0) this.#refCounts.delete(symbol)
        else this.#refCounts.set(symbol, count)
        return count === 0
      })
      if (stale.length > 0) this.#send({ type: 'unsubscribe', symbols: stale })
    }
  }

  watchPrice(symbol: string, listener: Listener): () => void {
    const listeners = this.#priceListeners.get(symbol) ?? new Set()
    listeners.add(listener)
    this.#priceListeners.set(symbol, listeners)
    return () => listeners.delete(listener)
  }

  price(symbol: string): LivePrice | undefined {
    return this.#prices.get(symbol)
  }

  /** Abertura e fechamento das operações do próprio usuário. */
  onTrade(listener: TradeListener): () => void {
    this.#tradeListeners.add(listener)
    return () => this.#tradeListeners.delete(listener)
  }

  #open(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#retry = 0
      const symbols = [...this.#refCounts.keys()]
      if (symbols.length > 0) this.#send({ type: 'subscribe', symbols })
    })
    socket.addEventListener('message', (event) => this.#handle(JSON.parse(event.data as string)))
    socket.addEventListener('close', () => {
      if (!this.#active) return
      const delay = Math.min(15_000, 500 * 2 ** this.#retry++)
      setTimeout(() => this.#active && this.#open(), delay)
    })
  }

  #handle(message: ServerMessage): void {
    if (message.type === 'tick') {
      const price = Number(message.price)
      const previous = this.#prices.get(message.symbol)?.price
      const direction =
        previous === undefined || previous === price ? 'flat' : price > previous ? 'up' : 'down'
      this.#prices.set(message.symbol, {
        price,
        time: message.time,
        open: Number(message.open),
        high: Number(message.high),
        low: Number(message.low),
        direction,
      })
      for (const listener of this.#priceListeners.get(message.symbol) ?? []) listener()
    } else if (message.type === 'trade') {
      for (const listener of this.#tradeListeners) listener(message.trade)
    }
  }

  #send(message: ClientMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message))
  }
}

export const marketStream = new MarketStream()

/** Assina os símbolos enquanto o componente estiver montado. */
export function useSubscription(symbols: readonly string[]): void {
  const key = symbols.join(',')
  useEffect(() => {
    if (!key) return
    return marketStream.subscribe(key.split(','))
  }, [key])
}

export function useLivePrice(symbol: string): LivePrice | undefined {
  return useSyncExternalStore(
    (listener) => marketStream.watchPrice(symbol, listener),
    () => marketStream.price(symbol),
  )
}

/**
 * Preço ao vivo de vários ativos de uma vez (somatório de posições, por exemplo). O snapshot é uma
 * string para o useSyncExternalStore comparar por valor e só re-renderizar quando algo mudar.
 */
export function useLivePrices(symbols: readonly string[]): ReadonlyMap<string, number> {
  const key = symbols.join(',')
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = key
        .split(',')
        .filter(Boolean)
        .map((symbol) => marketStream.watchPrice(symbol, listener))
      return () => {
        for (const stop of stops) stop()
      }
    },
    [key],
  )
  const snapshot = useSyncExternalStore(subscribe, () =>
    key
      .split(',')
      .filter(Boolean)
      .map((symbol) => `${symbol}=${marketStream.price(symbol)?.price ?? ''}`)
      .join('|'),
  )
  return useMemo(() => {
    const prices = new Map<string, number>()
    for (const entry of snapshot.split('|')) {
      const [symbol, price] = entry.split('=')
      if (symbol && price) prices.set(symbol, Number(price))
    }
    return prices
  }, [snapshot])
}
