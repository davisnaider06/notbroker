import {
  ACCOUNT_CURRENCY,
  type AccountDto,
  expiryFor,
  MAX_OPEN_TRADES,
  type Market,
  type OpenTradeInput,
  PAYOUT_RATE,
  type TradeDirection,
  type TradeDto,
  type TradeStatus,
} from '@notbroker/contracts'
import { Decimal } from 'decimal.js'
import { and, count, desc, eq } from 'drizzle-orm'
import type { Database } from '../db/client.ts'
import { binaryTrades, wallets } from '../db/schema/index.ts'
import { findInstrument } from '../market-data/catalog.ts'
import type { MarketDataHub } from '../market-data/hub.ts'
import type { Logger, Tick } from '../market-data/provider.ts'
import { AppError } from '../shared/errors.ts'

type TradeRow = typeof binaryTrades.$inferSelect
type TradeListener = (userId: string, trade: TradeDto) => void

const HISTORY_LIMIT = 100
const SETTLE_EVERY_MS = 200
/**
 * Idade máxima da cotação para abrir e para liquidar. Preço velho na entrada é resultado conhecido:
 * quem vê o preço de agora em outro lugar sabe para onde ele foi. Cripto negocia o tempo todo;
 * ações pelo IEX têm intervalos maiores entre negócios.
 */
const MAX_TICK_AGE_MS: Record<Market, number> = {
  CRYPTO: 5_000,
  US: 15_000,
  B3: 15_000,
}

interface OpenTrade {
  id: string
  userId: string
  symbol: string
  expiresAt: number
  /** 0 para ativo que saiu do catálogo: sem regra de preço, a operação é estornada. */
  maxTickAgeMs: number
  /** Último negócio até a expiração, capturado pelo primeiro tick que chega depois dela. */
  exitTick?: Tick
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
  readonly #lastTicks = new Map<string, Tick>()
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
      const previous = this.#lastTicks.get(tick.symbol)
      for (const trade of this.#open.values()) {
        if (trade.symbol !== tick.symbol || trade.exitTick !== undefined) continue
        if (trade.expiresAt <= tick.time) trade.exitTick = previous ?? tick
      }
      this.#lastTicks.set(tick.symbol, tick)
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

    if (!this.#hub.isRealtime(instrument.market)) {
      throw new AppError(
        409,
        'MARKET_DELAYED',
        'Binária indisponível nesse mercado: a cotação chega com atraso. Só o gráfico está liberado.',
      )
    }
    const now = this.#now()
    const tick = this.#hub.lastTick(instrument.symbol)
    if (!tick) throw new AppError(409, 'NO_PRICE', 'Ainda sem cotação para esse ativo')
    if (now - tick.time > MAX_TICK_AGE_MS[instrument.market]) {
      throw new AppError(
        409,
        'MARKET_CLOSED',
        'Sem cotação recente para esse ativo: mercado fechado ou feed parado',
      )
    }

    const stake = new Decimal(input.stake)
    const row = await this.#db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, ACCOUNT_CURRENCY)))
        .for('update')
      if (!wallet) throw new AppError(500, 'ACCOUNT_MISSING', 'Conta não encontrada')
      // Contado depois do lock na carteira: duas aberturas simultâneas não furam o teto.
      const [openCount] = await tx
        .select({ value: count() })
        .from(binaryTrades)
        .where(and(eq(binaryTrades.userId, userId), eq(binaryTrades.status, 'open')))
      if ((openCount?.value ?? 0) >= MAX_OPEN_TRADES) {
        throw new AppError(
          422,
          'TOO_MANY_OPEN_TRADES',
          `Limite de ${MAX_OPEN_TRADES} operações abertas ao mesmo tempo`,
        )
      }
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

  /**
   * Liquida o que venceu, no preço vigente no momento da expiração. Se o feed estava parado naquele
   * instante, o último preço não é o da expiração: a operação é estornada.
   */
  async settleDue(): Promise<void> {
    if (this.#settling) return
    this.#settling = true
    try {
      const now = this.#now()
      for (const trade of this.#open.values()) {
        if (trade.expiresAt > now) continue
        try {
          // Sem tick depois da expiração, o último negócio conhecido é o vigente naquele instante.
          const exit = trade.exitTick ?? this.#hub.lastTick(trade.symbol)
          await this.#settle(trade.id, exitPriceAt(trade, exit))
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
      maxTickAgeMs: maxTickAgeFor(row.symbol),
    })
  }

  #emit(userId: string, trade: TradeDto): void {
    for (const listener of this.#listeners) listener(userId, trade)
  }
}

function maxTickAgeFor(symbol: string): number {
  const instrument = findInstrument(symbol)
  return instrument ? MAX_TICK_AGE_MS[instrument.market] : 0
}

/** Preço de saída, ou null (estorno) quando o último negócio está longe demais da expiração. */
export function exitPriceAt(
  trade: { expiresAt: number; maxTickAgeMs: number },
  tick: Tick | undefined,
): string | null {
  if (!tick) return null
  return Math.abs(trade.expiresAt - tick.time) <= trade.maxTickAgeMs ? tick.price : null
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
