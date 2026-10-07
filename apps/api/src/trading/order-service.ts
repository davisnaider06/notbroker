import type { OrderDto, PlaceOrderInput, PositionDto, WalletDto } from '@b-hook/contracts'
import { Decimal } from 'decimal.js'
import { and, desc, eq } from 'drizzle-orm'
import type { Database, Transaction } from '../db/client.ts'
import { orders, positions, wallets } from '../db/schema/index.ts'
import { findInstrument, type Instrument } from '../market-data/catalog.ts'
import type { MarketDataHub } from '../market-data/hub.ts'
import type { Logger } from '../market-data/provider.ts'
import { AppError } from '../shared/errors.ts'
import {
  applyBuy,
  applySell,
  assertQuantityPrecision,
  EMPTY_POSITION,
  FEE_RATES,
  type PositionState,
  quote,
  round,
} from './ledger.ts'
import { MatchingEngine } from './matching-engine.ts'

type OrderRow = typeof orders.$inferSelect
type OrderListener = (userId: string, order: OrderDto) => void

const ORDER_HISTORY_LIMIT = 100

export class OrderService {
  readonly #db: Database
  readonly #hub: MarketDataHub
  readonly #engine: MatchingEngine
  readonly #listeners = new Set<OrderListener>()

  constructor(db: Database, hub: MarketDataHub, logger: Logger) {
    this.#db = db
    this.#hub = hub
    this.#engine = new MatchingEngine(
      (orderId, price) => this.#fillRestingOrder(orderId, price),
      (error, orderId) => logger.error({ err: error, orderId }, 'falha ao executar ordem limitada'),
    )
  }

  /** Recarrega as ordens limitadas abertas e passa a escutar o preço. */
  async start(): Promise<void> {
    const open = await this.#db.select().from(orders).where(eq(orders.status, 'open'))
    for (const order of open) this.#track(order)
    this.#hub.onTick((tick) => this.#engine.onPrice(tick.symbol, tick.price))
  }

  onOrderUpdate(listener: OrderListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async place(userId: string, input: PlaceOrderInput): Promise<OrderDto> {
    const instrument = findInstrument(input.symbol)
    if (!instrument) throw new AppError(404, 'UNKNOWN_SYMBOL', `Ativo ${input.symbol} não existe`)

    const quantity = new Decimal(input.quantity)
    assertQuantityPrecision(quantity, instrument.quantityDecimals)

    const row =
      input.type === 'market'
        ? await this.#placeMarket(userId, instrument, input.side, quantity)
        : await this.#placeLimit(userId, instrument, input.side, quantity, input.limitPrice)

    const order = toOrderDto(row)
    if (row.status === 'open') {
      this.#track(row)
      // Limite já "dentro" do mercado executa na hora, sem esperar o próximo tick.
      const lastPrice = this.#hub.lastPrice(row.symbol)
      if (lastPrice) this.#engine.onPrice(row.symbol, lastPrice)
    }
    this.#emit(userId, order)
    return order
  }

  async cancel(userId: string, orderId: string): Promise<OrderDto> {
    const row = await this.#db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
        .for('update')
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Ordem não encontrada')
      if (order.status !== 'open') {
        throw new AppError(409, 'ORDER_NOT_OPEN', 'Só ordens abertas podem ser canceladas')
      }
      const instrument = requireInstrument(order.symbol)

      if (order.side === 'buy') {
        const wallet = await lockWallet(tx, userId, instrument)
        const reserved = new Decimal(order.reserved ?? 0)
        await saveWallet(tx, userId, instrument, {
          balance: new Decimal(wallet.balance).plus(reserved),
          locked: new Decimal(wallet.locked).minus(reserved),
        })
      } else {
        const position = await lockPosition(tx, userId, instrument.symbol)
        await savePosition(tx, userId, instrument.symbol, {
          ...position,
          lockedQuantity: position.lockedQuantity.minus(order.quantity),
        })
      }

      const [canceled] = await tx
        .update(orders)
        .set({ status: 'canceled', canceledAt: new Date() })
        .where(eq(orders.id, order.id))
        .returning()
      return mustExist(canceled)
    })

    this.#engine.untrack(row.symbol, row.id)
    const order = toOrderDto(row)
    this.#emit(userId, order)
    return order
  }

  async listOrders(userId: string): Promise<OrderDto[]> {
    const rows = await this.#db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt))
      .limit(ORDER_HISTORY_LIMIT)
    return rows.map(toOrderDto)
  }

  async portfolio(userId: string): Promise<{ wallets: WalletDto[]; positions: PositionDto[] }> {
    const [walletRows, positionRows] = await Promise.all([
      this.#db.select().from(wallets).where(eq(wallets.userId, userId)),
      this.#db.select().from(positions).where(eq(positions.userId, userId)),
    ])
    return {
      wallets: walletRows.map((wallet) => ({
        currency: wallet.currency,
        balance: wallet.balance,
        locked: wallet.locked,
      })),
      positions: positionRows.map((position) => ({
        symbol: position.symbol,
        currency: requireInstrument(position.symbol).currency,
        quantity: position.quantity,
        lockedQuantity: position.lockedQuantity,
        averagePrice: position.averagePrice,
        realizedPnl: position.realizedPnl,
      })),
    }
  }

  #requirePrice(symbol: string): Decimal {
    const price = this.#hub.lastPrice(symbol)
    if (!price) {
      throw new AppError(409, 'NO_PRICE', `Ainda sem cotação para ${symbol}. Tente em instantes.`)
    }
    return new Decimal(price)
  }

  #placeMarket(
    userId: string,
    instrument: Instrument,
    side: 'buy' | 'sell',
    quantity: Decimal,
  ): Promise<OrderRow> {
    const price = this.#requirePrice(instrument.symbol)
    return this.#db.transaction(async (tx) => {
      await settleTrade(tx, userId, instrument, side, quantity, price)
      const { fee } = quote(quantity, price, FEE_RATES[instrument.market])
      const [order] = await tx
        .insert(orders)
        .values({
          userId,
          symbol: instrument.symbol,
          side,
          type: 'market',
          status: 'filled',
          quantity: quantity.toString(),
          fillPrice: price.toString(),
          fee: fee.toString(),
          filledAt: new Date(),
        })
        .returning()
      return mustExist(order)
    })
  }

  #placeLimit(
    userId: string,
    instrument: Instrument,
    side: 'buy' | 'sell',
    quantity: Decimal,
    limitPriceInput: string | undefined,
  ): Promise<OrderRow> {
    if (!limitPriceInput) throw new AppError(400, 'LIMIT_PRICE_REQUIRED', 'Informe o preço limite')
    const limitPrice = new Decimal(limitPriceInput)

    return this.#db.transaction(async (tx) => {
      let reserved: Decimal | null = null
      const wallet = await lockWallet(tx, userId, instrument)

      if (side === 'buy') {
        // Reserva o pior caso (limite + taxa); a diferença volta para o saldo no fill.
        const { notional, fee } = quote(quantity, limitPrice, FEE_RATES[instrument.market])
        reserved = notional.plus(fee)
        const balance = new Decimal(wallet.balance)
        if (balance.lessThan(reserved)) throw insufficientFunds(instrument)
        await saveWallet(tx, userId, instrument, {
          balance: balance.minus(reserved),
          locked: new Decimal(wallet.locked).plus(reserved),
        })
      } else {
        const position = await lockPosition(tx, userId, instrument.symbol)
        if (position.quantity.minus(position.lockedQuantity).lessThan(quantity)) {
          throw insufficientPosition()
        }
        await savePosition(tx, userId, instrument.symbol, {
          ...position,
          lockedQuantity: position.lockedQuantity.plus(quantity),
        })
      }

      const [order] = await tx
        .insert(orders)
        .values({
          userId,
          symbol: instrument.symbol,
          side,
          type: 'limit',
          status: 'open',
          quantity: quantity.toString(),
          limitPrice: limitPrice.toString(),
          reserved: reserved?.toString() ?? null,
        })
        .returning()
      return mustExist(order)
    })
  }

  async #fillRestingOrder(orderId: string, price: Decimal): Promise<void> {
    const row = await this.#db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update')
      // Pode ter sido cancelada entre o tick e o lock.
      if (order?.status !== 'open') return undefined
      const instrument = requireInstrument(order.symbol)
      const quantity = new Decimal(order.quantity)

      // Primeiro desfaz a reserva, depois liquida como uma ordem a mercado no preço do tick.
      const wallet = await lockWallet(tx, order.userId, instrument)
      if (order.side === 'buy') {
        const reserved = new Decimal(order.reserved ?? 0)
        await saveWallet(tx, order.userId, instrument, {
          balance: new Decimal(wallet.balance).plus(reserved),
          locked: new Decimal(wallet.locked).minus(reserved),
        })
      } else {
        const position = await lockPosition(tx, order.userId, instrument.symbol)
        await savePosition(tx, order.userId, instrument.symbol, {
          ...position,
          lockedQuantity: position.lockedQuantity.minus(quantity),
        })
      }
      await settleTrade(tx, order.userId, instrument, order.side, quantity, price)

      const { fee } = quote(quantity, price, FEE_RATES[instrument.market])
      const [filled] = await tx
        .update(orders)
        .set({
          status: 'filled',
          fillPrice: price.toString(),
          fee: fee.toString(),
          filledAt: new Date(),
        })
        .where(eq(orders.id, order.id))
        .returning()
      return mustExist(filled)
    })
    if (row) this.#emit(row.userId, toOrderDto(row))
  }

  #track(order: OrderRow): void {
    if (order.type !== 'limit' || order.status !== 'open' || !order.limitPrice) return
    this.#engine.track({
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      limitPrice: order.limitPrice,
    })
  }

  #emit(userId: string, order: OrderDto): void {
    for (const listener of this.#listeners) listener(userId, order)
  }
}

/**
 * Liquida um negócio: move caixa e posição. Ordem de lock fixa (carteira → posição) em todo o
 * serviço para duas ordens do mesmo usuário nunca entrarem em deadlock.
 */
async function settleTrade(
  tx: Transaction,
  userId: string,
  instrument: Instrument,
  side: 'buy' | 'sell',
  quantity: Decimal,
  price: Decimal,
): Promise<void> {
  const { notional, fee } = quote(quantity, price, FEE_RATES[instrument.market])
  const wallet = await lockWallet(tx, userId, instrument)
  const position = await lockPosition(tx, userId, instrument.symbol)
  const balance = new Decimal(wallet.balance)
  const locked = new Decimal(wallet.locked)

  if (side === 'buy') {
    const total = notional.plus(fee)
    if (balance.lessThan(total)) throw insufficientFunds(instrument)
    await saveWallet(tx, userId, instrument, { balance: balance.minus(total), locked })
    await savePosition(tx, userId, instrument.symbol, applyBuy(position, quantity, price, fee))
  } else {
    if (position.quantity.minus(position.lockedQuantity).lessThan(quantity)) {
      throw insufficientPosition()
    }
    await savePosition(tx, userId, instrument.symbol, applySell(position, quantity, price, fee))
    await saveWallet(tx, userId, instrument, { balance: balance.plus(notional).minus(fee), locked })
  }
}

async function lockWallet(tx: Transaction, userId: string, instrument: Instrument) {
  const [wallet] = await tx
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, instrument.currency)))
    .for('update')
  if (!wallet)
    throw new AppError(500, 'WALLET_MISSING', `Carteira ${instrument.currency} não existe`)
  return wallet
}

async function saveWallet(
  tx: Transaction,
  userId: string,
  instrument: Instrument,
  next: { balance: Decimal; locked: Decimal },
): Promise<void> {
  await tx
    .update(wallets)
    .set({ balance: round(next.balance).toString(), locked: round(next.locked).toString() })
    .where(and(eq(wallets.userId, userId), eq(wallets.currency, instrument.currency)))
}

async function lockPosition(
  tx: Transaction,
  userId: string,
  symbol: string,
): Promise<PositionState> {
  const [row] = await tx
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.symbol, symbol)))
    .for('update')
  if (!row) return EMPTY_POSITION
  return {
    quantity: new Decimal(row.quantity),
    lockedQuantity: new Decimal(row.lockedQuantity),
    averagePrice: new Decimal(row.averagePrice),
    realizedPnl: new Decimal(row.realizedPnl),
  }
}

async function savePosition(
  tx: Transaction,
  userId: string,
  symbol: string,
  next: PositionState,
): Promise<void> {
  const values = {
    quantity: next.quantity.toString(),
    lockedQuantity: next.lockedQuantity.toString(),
    averagePrice: next.averagePrice.toString(),
    realizedPnl: next.realizedPnl.toString(),
    updatedAt: new Date(),
  }
  await tx
    .insert(positions)
    .values({ userId, symbol, ...values })
    .onConflictDoUpdate({ target: [positions.userId, positions.symbol], set: values })
}

function requireInstrument(symbol: string): Instrument {
  const instrument = findInstrument(symbol)
  if (!instrument) throw new AppError(500, 'UNKNOWN_SYMBOL', `Ativo ${symbol} saiu do catálogo`)
  return instrument
}

function mustExist<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('escrita no banco não retornou a linha')
  return row
}

function insufficientFunds(instrument: Instrument): AppError {
  return new AppError(422, 'INSUFFICIENT_FUNDS', `Saldo em ${instrument.currency} insuficiente`)
}

function insufficientPosition(): AppError {
  return new AppError(422, 'INSUFFICIENT_POSITION', 'Quantidade disponível insuficiente')
}

function toOrderDto(row: OrderRow): OrderDto {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    status: row.status,
    quantity: row.quantity,
    limitPrice: row.limitPrice,
    fillPrice: row.fillPrice,
    fee: row.fee,
    currency: requireInstrument(row.symbol).currency,
    createdAt: row.createdAt.toISOString(),
    filledAt: row.filledAt?.toISOString() ?? null,
  }
}
