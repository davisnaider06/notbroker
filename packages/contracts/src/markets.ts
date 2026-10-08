import { z } from 'zod'

export const MARKETS = ['CRYPTO', 'US', 'B3'] as const
export type Market = (typeof MARKETS)[number]

/** Moeda em que cada mercado é cotado: cripto em USDT, EUA em USD, B3 em BRL. */
export const CURRENCIES = ['USDT', 'USD', 'BRL'] as const
export type Currency = (typeof CURRENCIES)[number]

export const MARKET_CURRENCY: Record<Market, Currency> = {
  CRYPTO: 'USDT',
  US: 'USD',
  B3: 'BRL',
}

/**
 * Atraso da fonte de cotação de cada mercado, em minutos. A B3 vem do Yahoo com ~15 min: não há
 * fonte grátis em tempo real. A tela avisa, porque operar em cima de preço velho sem saber engana.
 */
export const MARKET_DATA_DELAY_MINUTES: Record<Market, number> = {
  CRYPTO: 0,
  US: 0,
  B3: 15,
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
