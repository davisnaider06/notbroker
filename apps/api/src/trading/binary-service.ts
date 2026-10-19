import {
  ACCOUNT_CURRENCY,
  type AccountDto,
  entryWindow,
  entryWindowMs,
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
import { and, count, desc, eq, gte, ne, sum } from 'drizzle-orm'
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

/**
 * Quanto a abertura espera pelo próximo negócio. Cripto negocia várias vezes por segundo; ações
 * pelo IEX ficam alguns segundos sem negócio (AMZN: 2,8 s na mediana, 14 s no p95, medido em
 * 16/10/2026 na abertura do pregão).
 */
const ENTRY_WAIT_MS: Record<Market, number> = {
  CRYPTO: 3_000,
  US: 10_000,
  B3: 10_000,
}

interface OpenTrade {
  id: string
  userId: string
  symbol: string
  expiresAt: number
  /** 0 para ativo que saiu do catálogo: sem regra de preço, a operação é estornada. */
  maxTickAgeMs: number
  /** Quanto a liquidação espera pelo negócio que fecha a vela antes de usar o último conhecido. */
  settleGraceMs: number
  /** Último negócio até a expiração, capturado pelo primeiro tick que chega depois dela. */
  exitTick?: Tick
}

export interface BinaryServiceOptions {
  /** Relógio injetável: os testes avançam o tempo sem esperar a vela fechar. */
  now?: () => number
  /** Desligado nos testes, que chamam settleDue() na mão. */
  autoSettle?: boolean
  /**
   * Espera pelo negócio de entrada e, na expiração, pelo negócio que fecha a vela. Os testes usam
   * um prazo curto.
   */
  entryWaitMs?: Partial<Record<Market, number>>
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
  readonly #entryWaitMs: Record<Market, number>
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
    this.#entryWaitMs = { ...ENTRY_WAIT_MS, ...options.entryWaitMs }
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

    // Agregado no banco: o histórico da tela é limitado, o desempenho não pode ser.
    const rows = await this.#db
      .select({
        status: binaryTrades.status,
        trades: count(),
        staked: sum(binaryTrades.stake),
        returned: sum(binaryTrades.payout),
      })
      .from(binaryTrades)
      .where(
        and(
          eq(binaryTrades.userId, userId),
          ne(binaryTrades.status, 'open'),
          gte(binaryTrades.openedAt, wallet.startedAt),
        ),
      )
      .groupBy(binaryTrades.status)

    const stats = { won: 0, lost: 0, draw: 0, refunded: 0 }
    let staked = new Decimal(0)
    let returned = new Decimal(0)
    for (const row of rows) {
      if (row.status === 'open') continue
      stats[row.status] = row.trades
      staked = staked.plus(row.staked ?? 0)
      returned = returned.plus(row.returned ?? 0)
    }

    return {
      currency: ACCOUNT_CURRENCY,
      balance: wallet.balance,
      startingBalance: wallet.startingBalance,
      startedAt: wallet.startedAt.toISOString(),
      stats: { ...stats, staked: staked.toString(), netProfit: returned.minus(staked).toString() },
    }
  }

  /**
   * Começa uma banca nova com o saldo escolhido. Com operação aberta, recusa: zerar no meio dela
   * jogaria fora um resultado que ainda não saiu.
   */
  async reset(userId: string, balance: string): Promise<AccountDto> {
    await this.#db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, ACCOUNT_CURRENCY)))
        .for('update')
      if (!wallet) throw new AppError(500, 'ACCOUNT_MISSING', 'Conta não encontrada')
      // Depois do lock na carteira: uma abertura simultânea espera ou já aparece aqui.
      const [openCount] = await tx
        .select({ value: count() })
        .from(binaryTrades)
        .where(and(eq(binaryTrades.userId, userId), eq(binaryTrades.status, 'open')))
      if ((openCount?.value ?? 0) > 0) {
        throw new AppError(
          409,
          'TRADES_OPEN',
          'Espere as operações abertas fecharem para começar uma banca nova',
        )
      }
      await tx
        .update(wallets)
        .set({ balance, startingBalance: balance, startedAt: new Date(this.#now()) })
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, ACCOUNT_CURRENCY)))
    })
    return this.account(userId)
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
    // A expiração e a janela de entrada contam de quando a ordem chegou, no relógio do servidor.
    const now = this.#now()
    const window = entryWindow(now, input.expiration)
    if (!window.open) {
      const seconds = entryWindowMs(input.expiration) / 1000
      const wait = Math.ceil((window.nextOpensAt - now) / 1000)
      throw new AppError(
        409,
        'ENTRY_WINDOW_CLOSED',
        `Entrada só nos primeiros ${seconds} s da vela de ${input.expiration}. A próxima janela abre em ${wait} s.`,
      )
    }
    // Entrada no primeiro negócio depois da ordem, nunca no último antes dela. O último pode ter
    // segundos de idade (IEX parado, feed travado), e quem acompanha o mercado em outra fonte já
    // sabe para onde o preço foi. O próximo negócio ninguém conhece na hora do clique.
    const waitMs = this.#entryWaitMs[instrument.market]
    const tick = await this.#hub.nextTick(instrument.symbol, waitMs)
    if (!tick) {
      throw new AppError(
        409,
        'NO_FRESH_PRICE',
        `Nenhum negócio novo em ${waitMs / 1000} s: mercado parado ou feed travado. Tente de novo.`,
      )
    }
    // Negócio novo com horário velho (fila de reconexão): também não serve de entrada.
    if (this.#now() - tick.time > MAX_TICK_AGE_MS[instrument.market]) {
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
   * Liquida o que venceu, no preço vigente no momento da expiração. Espera o primeiro negócio
   * depois dela: até ele chegar, ainda pode vir negócio de antes da virada (latência da bolsa), e é
   * ele que fecha a vela no gráfico. Se o feed estava parado naquele instante, o último preço não é
   * o da expiração: a operação é estornada.
   */
  async settleDue(): Promise<void> {
    if (this.#settling) return
    this.#settling = true
    try {
      const now = this.#now()
      for (const trade of this.#open.values()) {
        if (trade.expiresAt > now) continue
        if (trade.exitTick === undefined && now < trade.expiresAt + trade.settleGraceMs) continue
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
      settleGraceMs: this.#settleGraceFor(row.symbol),
    })
  }

  #settleGraceFor(symbol: string): number {
    const instrument = findInstrument(symbol)
    return instrument ? this.#entryWaitMs[instrument.market] : 0
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
