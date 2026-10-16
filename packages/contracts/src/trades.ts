import { z } from 'zod'

/**
 * Regras da casa de opções binárias. Ficam no contrato para a tela calcular expiração e retorno
 * com a mesma regra que o servidor aplica.
 */
export const ACCOUNT_CURRENCY = 'BRL' as const
export const STARTING_BALANCE = '10000'
/** Win devolve o valor apostado + 70% dele. Loss perde o valor inteiro. */
export const PAYOUT_RATE = '0.70'
export const MIN_STAKE = 1
/** Teto de operações abertas ao mesmo tempo por usuário. */
export const MAX_OPEN_TRADES = 20
/** Com menos que isso para a vela fechar, a operação vai para a vela seguinte. */
export const ENTRY_CUTOFF_SECONDS = 30

/** buy = aposta que o preço fecha acima da entrada; sell = abaixo. */
export const TRADE_DIRECTIONS = ['buy', 'sell'] as const
export type TradeDirection = (typeof TRADE_DIRECTIONS)[number]

/** refunded: o servidor estava fora do ar na expiração, então o valor volta sem resultado. */
export const TRADE_STATUSES = ['open', 'won', 'lost', 'draw', 'refunded'] as const
export type TradeStatus = (typeof TRADE_STATUSES)[number]

export const EXPIRATIONS = ['1m', '5m', '15m', '1h'] as const
export type Expiration = (typeof EXPIRATIONS)[number]

export const EXPIRATION_SECONDS: Record<Expiration, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
}

/**
 * A operação fecha junto com a vela do tempo escolhido. Velas são alinhadas ao relógio UTC,
 * como as da Binance e o contador "Próxima vela em" do gráfico.
 */
export function expiryFor(nowMs: number, expiration: Expiration): number {
  const bucketMs = EXPIRATION_SECONDS[expiration] * 1000
  const candleEnd = Math.floor(nowMs / bucketMs) * bucketMs + bucketMs
  return candleEnd - nowMs < ENTRY_CUTOFF_SECONDS * 1000 ? candleEnd + bucketMs : candleEnd
}

export const openTradeSchema = z.object({
  symbol: z.string().trim().toUpperCase(),
  direction: z.enum(TRADE_DIRECTIONS),
  /** Valor em reais, com no máximo 2 casas. String para nunca passar por float. */
  stake: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'valor deve ter no máximo 2 casas decimais')
    .refine((value) => Number(value) >= MIN_STAKE, `valor mínimo é R$ ${MIN_STAKE}`),
  expiration: z.enum(EXPIRATIONS),
})

export type OpenTradeInput = z.infer<typeof openTradeSchema>

export interface TradeDto {
  id: string
  symbol: string
  direction: TradeDirection
  status: TradeStatus
  stake: string
  payoutRate: string
  entryPrice: string
  exitPrice: string | null
  /** Quanto voltou para o saldo no fechamento (valor + lucro no win, valor no empate, 0 no loss). */
  payout: string | null
  openedAt: string
  expiresAt: string
  settledAt: string | null
}

/** Faixa aceita ao começar uma banca nova. */
export const MIN_STARTING_BALANCE = 10
export const MAX_STARTING_BALANCE = 1_000_000

/** Recomeça a conta com o saldo escolhido; o desempenho passa a contar dali. */
export const resetAccountSchema = z.object({
  balance: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'saldo deve ter no máximo 2 casas decimais')
    .refine(
      (value) => Number(value) >= MIN_STARTING_BALANCE && Number(value) <= MAX_STARTING_BALANCE,
      `saldo entre R$ ${MIN_STARTING_BALANCE} e R$ ${MAX_STARTING_BALANCE.toLocaleString('pt-BR')}`,
    ),
})

export type ResetAccountInput = z.infer<typeof resetAccountSchema>

/** Desempenho das operações fechadas desde o início da banca atual. */
export interface AccountStatsDto {
  won: number
  lost: number
  draw: number
  refunded: number
  /** Soma dos valores apostados nas operações fechadas. */
  staked: string
  /** Soma de (retorno − valor) nas operações fechadas. */
  netProfit: string
}

export interface AccountDto {
  currency: typeof ACCOUNT_CURRENCY
  balance: string
  /** Saldo com que a banca atual começou. */
  startingBalance: string
  startedAt: string
  stats: AccountStatsDto
}

/** Acerto mínimo para empatar: cada win paga PAYOUT_RATE, cada loss perde 1. */
export const BREAKEVEN_WIN_RATE = 1 / (1 + Number(PAYOUT_RATE))

/**
 * Situação de uma operação se fechasse agora. Mesma regra do servidor, em number: serve só para a
 * tela mostrar "ganhando/perdendo"; a liquidação de verdade compara decimais no servidor.
 */
export function previewOutcome(
  direction: TradeDirection,
  entryPrice: number,
  currentPrice: number,
): 'won' | 'lost' | 'draw' {
  if (currentPrice === entryPrice) return 'draw'
  return currentPrice > entryPrice === (direction === 'buy') ? 'won' : 'lost'
}
