import type { Currency, DisplayCurrency } from '@notbroker/contracts'

/** Moeda de liquidação (USDT, USD, BRL) ou de exibição (USD, EUR, GBP, BRL). */
export type Money = Currency | DisplayCurrency

const ISO_CURRENCY: Partial<Record<Money, string>> = {
  USD: 'USD',
  BRL: 'BRL',
  EUR: 'EUR',
  GBP: 'GBP',
}

/** Casas decimais de preço conforme a grandeza: BTC em 2, XRP em 4, memecoin em até 8. */
export function priceDecimals(price: number): number {
  const abs = Math.abs(price)
  if (abs === 0 || abs >= 1) return 2
  if (abs >= 0.01) return 4
  return 8
}

export function formatPrice(
  value: string | number,
  currency: Money,
  decimals = priceDecimals(Number(value)),
): string {
  const number = Number(value)
  const iso = ISO_CURRENCY[currency]
  if (iso) {
    return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'pt-BR', {
      style: 'currency',
      currency: iso,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(number)
  }
  // USDT não é moeda ISO: número com o ticker ao lado.
  return `${formatNumber(number, decimals, decimals)} ${currency}`
}

/** Saldo, taxa e resultado: dinheiro sempre em 2 casas, independente da grandeza. */
export function formatMoney(value: string | number, currency: Money): string {
  return formatPrice(value, currency, 2)
}

export function formatNumber(value: string | number, minDecimals = 0, maxDecimals = 8): string {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
  }).format(Number(value))
}

export function formatQuantity(value: string | number, decimals: number): string {
  return formatNumber(value, 0, decimals)
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso))
}

/** Tempo até o candle fechar: "0:42" no 1m, "14:05" no 15m, "3:12:09" no diário. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  return `${minutes}:${seconds}`
}
