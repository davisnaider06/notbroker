import type { Currency } from './markets.ts'

/** Moedas em que a tela pode exibir valores. Só exibição: as ordens seguem na moeda do ativo. */
export const DISPLAY_CURRENCIES = ['USD', 'EUR', 'GBP', 'BRL'] as const
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number]

export interface FxRatesDto {
  /** Quanto 1 USD vale em cada moeda (USD = 1). */
  perUsd: Record<DisplayCurrency, number>
  /** Epoch em ms da última atualização bem-sucedida. */
  updatedAt: number
}

/**
 * Converte um valor da moeda de liquidação para a moeda de exibição.
 * USDT é tratado como 1:1 com USD: a diferença real fica em frações de centavo.
 */
export function convertCurrency(
  value: number,
  from: Currency,
  to: DisplayCurrency,
  rates: FxRatesDto,
): number {
  const source: DisplayCurrency = from === 'USDT' ? 'USD' : from
  return (value / rates.perUsd[source]) * rates.perUsd[to]
}
