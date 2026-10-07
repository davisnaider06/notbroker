import type { OrderSide } from '@b-hook/contracts'
import { Decimal } from 'decimal.js'
import { crosses } from './ledger.ts'

export interface RestingOrder {
  id: string
  symbol: string
  side: OrderSide
  limitPrice: string
}

type CrossHandler = (orderId: string, price: Decimal) => Promise<void>

/**
 * Livro de ordens limitadas em memória, indexado por símbolo. Não toca no banco: quando o preço
 * cruza, entrega a ordem ao `onCross`, que faz o fill transacional. O banco continua sendo a
 * fonte da verdade; este índice é reconstruído a partir dele no boot.
 */
export class MatchingEngine {
  readonly #book = new Map<string, Map<string, { side: OrderSide; limitPrice: Decimal }>>()
  readonly #onCross: CrossHandler
  readonly #onError: (error: unknown, orderId: string) => void

  constructor(onCross: CrossHandler, onError: (error: unknown, orderId: string) => void) {
    this.#onCross = onCross
    this.#onError = onError
  }

  track(order: RestingOrder): void {
    const orders = this.#book.get(order.symbol) ?? new Map()
    orders.set(order.id, { side: order.side, limitPrice: new Decimal(order.limitPrice) })
    this.#book.set(order.symbol, orders)
  }

  untrack(symbol: string, orderId: string): void {
    this.#book.get(symbol)?.delete(orderId)
  }

  /** Retorna os ids disparados (útil em teste). O fill roda em background. */
  onPrice(symbol: string, price: string): string[] {
    const orders = this.#book.get(symbol)
    if (!orders || orders.size === 0) return []

    const marketPrice = new Decimal(price)
    const triggered: string[] = []
    for (const [orderId, order] of orders) {
      if (!crosses(order.side, order.limitPrice, marketPrice)) continue
      // Sai do livro antes do fill assíncrono para o próximo tick não disparar a mesma ordem.
      orders.delete(orderId)
      triggered.push(orderId)
      this.#onCross(orderId, marketPrice).catch((error: unknown) => this.#onError(error, orderId))
    }
    return triggered
  }

  get size(): number {
    let total = 0
    for (const orders of this.#book.values()) total += orders.size
    return total
  }
}
