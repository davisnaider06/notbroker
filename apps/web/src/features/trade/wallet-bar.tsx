import { ACCOUNT_CURRENCY, type AccountDto } from '@notbroker/contracts'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../../lib/api.ts'
import { formatMoney } from '../../lib/format.ts'

/**
 * Saldo da conta. Não acompanha o preço: só muda quando uma operação abre (sai o valor) ou
 * fecha (volta valor + payout, ou nada).
 */
export function WalletBar() {
  const account = useQuery({ queryKey: queryKeys.account, queryFn: api.account })
  const trades = useQuery({ queryKey: queryKeys.trades, queryFn: api.trades })
  const inPlay = (trades.data ?? [])
    .filter((trade) => trade.status === 'open')
    .reduce((sum, trade) => sum + Number(trade.stake), 0)

  return (
    <div className="wallets">
      <div className="wallet">
        <span className="label">Saldo</span>
        <strong>{account.data ? formatMoney(account.data.balance, ACCOUNT_CURRENCY) : '—'}</strong>
        {account.data && <BancaResult account={account.data} inPlay={inPlay} />}
        {inPlay > 0 && (
          <span className="muted small">
            {formatMoney(inPlay, ACCOUNT_CURRENCY)} em operações abertas
          </span>
        )}
      </div>
    </div>
  )
}

/** Quanto a banca andou desde o início, contando o que está em jogo pelo valor apostado. */
function BancaResult({ account, inPlay }: { account: AccountDto; inPlay: number }) {
  const result = Number(account.balance) + inPlay - Number(account.startingBalance)
  const tone = result > 0 ? 'up' : result < 0 ? 'down' : 'muted'
  return (
    <span
      className={`small ${tone}`}
      title={`Banca começou com ${formatMoney(account.startingBalance, ACCOUNT_CURRENCY)}`}
    >
      {result > 0 ? '+' : ''}
      {formatMoney(result, ACCOUNT_CURRENCY)} na banca
    </span>
  )
}
