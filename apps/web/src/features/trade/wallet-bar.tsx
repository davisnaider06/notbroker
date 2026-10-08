import type { Currency, PositionDto, WalletDto } from '@b-hook/contracts'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../../lib/api.ts'
import { useMoneyFormatter } from '../../lib/display-currency.ts'
import { formatMoney } from '../../lib/format.ts'
import { useLivePrices } from '../../lib/market-stream.ts'

interface Equity {
  currency: Currency
  /** Caixa + reservado em ordens + posições a preço de mercado. */
  total: number
  /** Ganho ou perda ainda não realizado das posições abertas. */
  openResult: number
  cash: number
  locked: number
}

/**
 * Patrimônio por carteira, ao vivo. O saldo em caixa só muda quando uma ordem executa; o
 * patrimônio acompanha cada tick das posições abertas, que é o que mostra se o trade está ganhando.
 */
function computeEquity(
  wallets: WalletDto[],
  positions: PositionDto[],
  prices: ReadonlyMap<string, number>,
): Equity[] {
  return wallets.map((wallet) => {
    let marketValue = 0
    let openResult = 0
    for (const position of positions) {
      const quantity = Number(position.quantity)
      if (position.currency !== wallet.currency || quantity === 0) continue
      const average = Number(position.averagePrice)
      const price = prices.get(position.symbol) ?? average
      marketValue += quantity * price
      openResult += quantity * (price - average)
    }
    const cash = Number(wallet.balance)
    const locked = Number(wallet.locked)
    return {
      currency: wallet.currency,
      total: cash + locked + marketValue,
      openResult,
      cash,
      locked,
    }
  })
}

const signed = (value: number, currency: Currency) =>
  `${value > 0 ? '+' : ''}${formatMoney(value, currency)}`

const tone = (value: number) => (value > 0.005 ? 'up' : value < -0.005 ? 'down' : 'muted')

export function WalletBar() {
  const { data } = useQuery({ queryKey: queryKeys.portfolio, queryFn: api.portfolio })
  const held = (data?.positions ?? []).filter((position) => Number(position.quantity) > 0)
  const prices = useLivePrices(held.map((position) => position.symbol))
  const money = useMoneyFormatter()

  if (!data) return <div className="wallets" />
  const equities = computeEquity(data.wallets, data.positions, prices)
  const converted = equities.map((equity) => money.convert(equity.total, equity.currency))
  const grandTotal = converted.every((value) => value !== null)
    ? converted.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null

  return (
    <div className="wallets">
      {money.display !== 'ORIGINAL' && grandTotal !== null && (
        <div className="wallet wallet-total">
          <span className="label">Patrimônio total</span>
          <strong>{formatMoney(grandTotal, money.display)}</strong>
          <span className="muted small">3 carteiras em {money.display}</span>
        </div>
      )}
      {equities.map((equity) => (
        <div key={equity.currency} className="wallet">
          <span className="label">{equity.currency}</span>
          <strong>
            {formatMoney(equity.total, equity.currency)}
            {equity.openResult !== 0 && (
              <span className={`wallet-result ${tone(equity.openResult)}`}>
                {signed(equity.openResult, equity.currency)}
              </span>
            )}
          </strong>
          <span className="muted small">
            caixa {formatMoney(equity.cash, equity.currency)}
            {equity.locked > 0 && ` · ${formatMoney(equity.locked, equity.currency)} em ordens`}
          </span>
        </div>
      ))}
    </div>
  )
}
