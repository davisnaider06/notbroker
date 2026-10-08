import {
  ACCOUNT_CURRENCY,
  type AccountDto,
  expiryFor,
  type OpenTradeInput,
  PAYOUT_RATE,
  type TradeDirection,
  type TradeDto,
  type TradeStatus,
} from '@b-hook/contracts'
import { Decimal } from 'decimal.js'
import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../db/client.ts'
import { binaryTrades, wallets } from '../db/schema/index.ts'
import { findInstrument } from '../market-data/catalog.ts'
import type { MarketDataHub } from '../market-data/hub.ts'
import type { Logger } from '../market-data/provider.ts'
import { AppError } from '../shared/errors.ts'

type TradeRow = typeof binaryTrades.$inferSelect
type TradeListener = (userId: string, trade: TradeDto) => void

const HISTORY_LIMIT = 100
const SETTLE_EVERY_MS = 200
/**
 * Cotação mais velha que isso = mercado fechado. 20 min porque a B3 pelo Yahoo já chega com
 * ~15 min de atraso; fora do pregão a última cotação tem horas.
 */
const MARKET_STALE_MS = 20 * 60_000

interface OpenTrade {
  id: string
  userId: string
  symbol: string
  expiresAt: number
  /** Preço vigente na expiração, capturado pelo primeiro tick que chega depois dela. */
  exitPrice?: string
}

export interface BinaryServiceOptions {
  /** Relógio injetável: os testes avançam o tempo sem esperar a vela fechar. */
  now?: () => number
  /** Desligado nos testes, que chamam settleDue() na mão. */
  autoSettle?: boolean
}

/**
 * Casa de opções binárias. Abrir debita o valor do saldo; na expiração compara o preço de saída
 * com o de entrada: acertou a direção = valor + payout, errou = perde o valor, igual = devolve.
 */
export class BinaryService {
  readonly #db: Database
  readonly #hub: MarketDataHub
  readonly #logger: Logger
  readonly #now: () => number
  readonly #autoSettle: boolean
  readonly #open = new Map<string, OpenTrade>()
  readonly #listeners = new Set<TradeListener>()
  readonly #prices = new Map<string, string>()
  #timer: NodeJS.Timeout | undefined
  #settling = false

  constructor(
    db: Database,
    hub: MarketDataHub,
    logger: Logger,
    options: BinaryServiceOptions = {},
  ) {
    this.#db = db
    this.#hub = hub
    this.#logger = logger
    this.#now = options.now ?? Date.now
    this.#autoSettle = options.autoSettle ?? true
  }

  /**
   * Recarrega as operações abertas. As que venceram com o servidor fora do ar são estornadas:
   * não temos o preço exato daquele instante, e inventar um resultado seria pior.
   */
  async start(): Promise<void> {
    const rows = await this.#db.select().from(binaryTrades).where(eq(binaryTrades.status, 'open'))
    for (const row of rows) {
      if (row.expiresAt.getTime() <= this.#now()) await this.#settle(row.id, null)
      else this.#track(row)
    }
    this.#hub.onTick((tick) => {
      for (const trade of this.#open.values()) {
        if (trade.symbol !== tick.symbol || trade.exitPrice !== undefined) continue
        if (trade.expiresAt <= tick.time)
          trade.exitPrice = this.#prices.get(tick.symbol) ?? tick.price
      }
      this.#prices.set(tick.symbol, tick.price)
    })
    if (this.#autoSettle) {
      this.#timer = setInterval(() => void this.settleDue(), SETTLE_EVERY_MS)
    }
  }

  stop(): void {
    clearInterval(this.#timer)
  }

  onTradeUpdate(listener: TradeListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async account(userId: string): Promise<AccountDto> {
    const [wallet] = await this.#db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.currency, ACCOUNT_CURRENCY)))
    if (!wallet) throw new AppError(500, 'ACCOUNT_MISSING', 'Conta não encontrada')
    return { currency: ACCOUNT_CURRENCY, balance: wallet.balance }
  }

  async list(userId: string): Promise<TradeDto[]> {
    const rows = await this.#db
      .select()
      .from(binaryTrades)
      .where(eq(binaryTrades.userId, userId))
      .orderBy(desc(binaryTrades.openedAt))
      .limit(HISTORY_LIMIT)
    return rows.map(toTradeDto)
  }

  async open(userId: string, input: OpenTradeInput): Promise<TradeDto> {
    const instrument = findInstrument(input.symbol)
    if (!instrument) throw new AppError(404, 'UNKNOWN_SYMBOL', `Ativo ${input.symbol} não existe`)

    const now = this.#now()
    const tick = this.#hub.lastTick(instrument.symbol)
    if (!tick) throw new AppError(409, 'NO_PRICE', 'Ainda sem cotação para esse ativo')
    if (now - tick.time > MARKET_STALE_MS) {
      throw new AppError(409, 'MARKET_CLOSED', 'Mercado fechado para esse ativo agora')
    }

    const stake = new Decimal(input.stake)
    const row = await this.#db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, ACCOUNT_CURRENCY)))
        .for('update')
      if (!wallet) throw new AppError(500, 'ACCOUNT_MISSING', 'Conta não encontrada')
      const balance = new Decimal(wallet.balance)
      if (balance.lessThan(stake)) {
        throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Saldo insuficiente para esse valor')
      }
      await tx
        .update(wallets)
        .set({ balance: balance.minus(stake).toString() })
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, ACCOUNT_CURRENCY)))
      const [inserted] = await tx
        .insert(binaryTrades)
        .values({
          userId,
          symbol: instrument.symbol,
          direction: input.direction,
          status: 'open',
          stake: stake.toString(),
          payoutRate: PAYOUT_RATE,
          entryPrice: tick.price,
          openedAt: new Date(now),
          expiresAt: new Date(expiryFor(now, input.expiration)),
        })
        .returning()
      return mustExist(inserted)
    })

    this.#track(row)
    const trade = toTradeDto(row)
    this.#emit(userId, trade)
    return trade
  }

  /** Liquida o que venceu, no preço vigente no momento da expiração. */
  async settleDue(): Promise<void> {
    if (this.#settling) return
    this.#settling = true
    try {
      const now = this.#now()
      for (const trade of this.#open.values()) {
        if (trade.expiresAt > now) continue
        try {
          // Sem tick depois da expiração, o último preço conhecido é o vigente naquele instante.
          await this.#settle(trade.id, trade.exitPrice ?? this.#hub.lastPrice(trade.symbol) ?? null)
        } catch (error) {
          this.#logger.error({ err: error, tradeId: trade.id }, 'falha ao liquidar operação')
        }
      }
    } finally {
      this.#settling = false
    }
  }

  async #settle(tradeId: string, exitPrice: string | null): Promise<void> {
    const settled = await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(binaryTrades)
        .where(eq(binaryTrades.id, tradeId))
        .for('update')
      if (row?.status !== 'open') return undefined

      const stake = new Decimal(row.stake)
      const status = exitPrice === null ? 'refunded' : outcome(row.direction, row, exitPrice)
      const payout = payoutFor(status, stake, new Decimal(row.payoutRate))

      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, ACCOUNT_CURRENCY)))
        .for('update')
      if (!wallet) throw new AppError(500, 'ACCOUNT_MISSING', 'Conta não encontrada')
      if (payout.greaterThan(0)) {
        await tx
          .update(wallets)
          .set({ balance: new Decimal(wallet.balance).plus(payout).toString() })
          .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, ACCOUNT_CURRENCY)))
      }
      const [updated] = await tx
        .update(binaryTrades)
        .set({ status, exitPrice, payout: payout.toString(), settledAt: new Date(this.#now()) })
        .where(eq(binaryTrades.id, tradeId))
        .returning()
      return mustExist(updated)
    })

    this.#open.delete(tradeId)
    if (settled) this.#emit(settled.userId, toTradeDto(settled))
  }

  #track(row: TradeRow): void {
    this.#open.set(row.id, {
      id: row.id,
      userId: row.userId,
      symbol: row.symbol,
      expiresAt: row.expiresAt.getTime(),
    })
  }

  #emit(userId: string, trade: TradeDto): void {
    for (const listener of this.#listeners) listener(userId, trade)
  }
}

/** Compra ganha se fechou acima da entrada; venda ganha se fechou abaixo; igual é empate. */
export function outcome(
  direction: TradeDirection,
  trade: { entryPrice: string },
  exitPrice: string,
): Exclude<TradeStatus, 'open' | 'refunded'> {
  const comparison = new Decimal(exitPrice).comparedTo(trade.entryPrice)
  if (comparison === 0) return 'draw'
  const wentUp = comparison > 0
  return wentUp === (direction === 'buy') ? 'won' : 'lost'
}

/** Quanto volta para o saldo: win = valor + payout, empate/estorno = valor, loss = nada. */
export function payoutFor(status: TradeStatus, stake: Decimal, payoutRate: Decimal): Decimal {
  if (status === 'won') return stake.plus(stake.times(payoutRate)).toDecimalPlaces(2)
  if (status === 'draw' || status === 'refunded') return stake
  return new Decimal(0)
}

function toTradeDto(row: TradeRow): TradeDto {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    status: row.status,
    stake: row.stake,
    payoutRate: row.payoutRate,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    payout: row.payout,
    openedAt: row.openedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  }
}

function mustExist<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('escrita no banco não retornou a linha')
  return row
}
