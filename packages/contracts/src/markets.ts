import { z } from 'zod'

export const MARKETS = ['CRYPTO', 'US', 'B3'] as const
export type Market = (typeof MARKETS)[number]

/** Cada mercado liquida numa moeda: cripto em USDT, EUA em USD, B3 em BRL. */
export const CURRENCIES = ['USDT', 'USD', 'BRL'] as const
export type Currency = (typeof CURRENCIES)[number]

export const MARKET_CURRENCY: Record<Market, Currency> = {
  CRYPTO: 'USDT',
  US: 'USD',
  B3: 'BRL',
}

/**
 * Corretagem simulada, próxima da realidade de cada mercado:
 * Binance spot 0,1% · Alpaca sem comissão · B3 ~0,03% de emolumentos (corretagem zero).
 * Fica no contrato para a tela estimar o custo com a mesma regra que o servidor cobra.
 */
export const MARKET_FEE_RATES: Record<Market, string> = {
  CRYPTO: '0.001',
  US: '0',
  B3: '0.0003',
}

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '1d'] as const
export type CandleInterval = (typeof CANDLE_INTERVALS)[number]

export const candlesQuerySchema = z.object({
  interval: z.enum(CANDLE_INTERVALS).default('1m'),
})

export interface InstrumentDto {
  symbol: string
  name: string
  market: Market
  currency: Currency
  /** Casas decimais aceitas na quantidade (0 para ações, 6 para BTC...). */
  quantityDecimals: number
  /** Último preço conhecido pelo servidor, ou null se o feed ainda não respondeu. */
  lastPrice: string | null
}

/** Candle com tempo em segundos UNIX, formato que o lightweight-charts consome direto. */
export interface CandleDto {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}
