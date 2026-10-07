import type { Currency } from '@b-hook/contracts'

const ISO_CURRENCY: Partial<Record<Currency, string>> = { USD: 'USD', BRL: 'BRL' }

/** Casas decimais de preço conforme a grandeza: BTC em 2, XRP em 4, memecoin em até 8. */
export function priceDecimals(price: number): number {
  const abs = Math.abs(price)
  if (abs === 0 || abs >= 1) return 2
  if (abs >= 0.01) return 4
  return 8
}

export function formatPrice(
  value: string | number,
  currency: Currency,
  decimals = priceDecimals(Number(value)),
): string {
  const number = Number(value)
  const iso = ISO_CURRENCY[currency]
  if (iso) {
    return new Intl.NumberFormat(currency === 'BRL' ? 'pt-BR' : 'en-US', {
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
export function formatMoney(value: string | number, currency: Currency): string {
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
