import { MIN_STAKE } from '@notbroker/contracts'

/**
 * Valor que corresponde a uma fração do saldo, arredondado para baixo no centavo e nunca abaixo do
 * mínimo da casa. null quando o saldo não cobre nem o mínimo.
 */
export function stakeForPercent(balance: string | number, percent: number): string | null {
  const balanceCents = Math.floor(Number(balance) * 100)
  if (balanceCents < MIN_STAKE * 100) return null
  const cents = Math.max(MIN_STAKE * 100, Math.floor((balanceCents * percent) / 100))
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)
}
