import type { ClientMessage, OrderDto, ServerMessage } from '@b-hook/contracts'
import { useEffect, useSyncExternalStore } from 'react'

export interface LivePrice {
  price: number
  time: number
  /** Direção em relação ao tick anterior, para o "flash" verde/vermelho. */
  direction: 'up' | 'down' | 'flat'
}

type Listener = () => void
type OrderListener = (order: OrderDto) => void

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
  readonly #orderListeners = new Set<OrderListener>()

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

  onOrder(listener: OrderListener): () => void {
    this.#orderListeners.add(listener)
    return () => this.#orderListeners.delete(listener)
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
      this.#prices.set(message.symbol, { price, time: message.time, direction })
      for (const listener of this.#priceListeners.get(message.symbol) ?? []) listener()
    } else if (message.type === 'order') {
      for (const listener of this.#orderListeners) listener(message.order)
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
