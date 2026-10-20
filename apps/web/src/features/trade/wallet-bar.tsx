import { ACCOUNT_CURRENCY, type AccountDto } from '@notbroker/contracts'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useAccountKind } from '../../lib/account-kind.tsx'
import { api, queryKeys } from '../../lib/api.ts'
import { formatMoney } from '../../lib/format.ts'
import { DepositDialog } from '../payments/deposit-dialog.tsx'
import { WithdrawDialog } from '../payments/withdraw-dialog.tsx'

/**
 * Saldo da conta ativa. Não acompanha o preço: só muda quando uma operação abre (sai o valor) ou
 * fecha (volta valor + payout, ou nada), e na conta real com depósito e saque.
 */
export function WalletBar() {
  const { kind } = useAccountKind()
  const [dialog, setDialog] = useState<'deposit' | 'withdraw' | null>(null)
  const account = useQuery({ queryKey: queryKeys.account(kind), queryFn: () => api.account(kind) })
  const trades = useQuery({ queryKey: queryKeys.trades(kind), queryFn: () => api.trades(kind) })
  const payments = useQuery({
    queryKey: queryKeys.payments,
    queryFn: api.payments,
    enabled: kind === 'real',
  })
  const inPlay = (trades.data ?? [])
    .filter((trade) => trade.status === 'open')
    .reduce((sum, trade) => sum + Number(trade.stake), 0)
  const realEnabled = payments.data?.enabled ?? false

  return (
    <div className="wallets">
      <AccountSwitch />
      <div className="wallet">
        <span className="label">{kind === 'real' ? 'Saldo real' : 'Saldo demo'}</span>
        <strong>{account.data ? formatMoney(account.data.balance, ACCOUNT_CURRENCY) : '—'}</strong>
        {account.data && <BancaResult account={account.data} inPlay={inPlay} />}
        {inPlay > 0 && (
          <span className="muted small">
            {formatMoney(inPlay, ACCOUNT_CURRENCY)} em operações abertas
          </span>
        )}
      </div>
      {kind === 'real' && (
        <div className="wallet-actions">
          <button
            type="button"
            className="primary small"
            disabled={!realEnabled}
            onClick={() => setDialog('deposit')}
          >
            Depositar
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={!realEnabled}
            onClick={() => setDialog('withdraw')}
          >
            Sacar
          </button>
          {payments.data && !realEnabled && (
            <span className="muted small">Conta real desligada no servidor</span>
          )}
        </div>
      )}
      {dialog === 'deposit' && <DepositDialog onClose={() => setDialog(null)} />}
      {dialog === 'withdraw' && account.data && (
        <WithdrawDialog balance={account.data.balance} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}

function AccountSwitch() {
  const { kind, setKind } = useAccountKind()
  return (
    <fieldset className="segmented account-switch" aria-label="Conta">
      <button
        type="button"
        aria-pressed={kind === 'demo'}
        className={kind === 'demo' ? 'active' : ''}
        onClick={() => setKind('demo')}
      >
        Demo
      </button>
      <button
        type="button"
        aria-pressed={kind === 'real'}
        className={kind === 'real' ? 'active real' : ''}
        onClick={() => setKind('real')}
      >
        Real
      </button>
    </fieldset>
  )
}

/**
 * Demo: quanto a banca andou desde o início, contando o que está em jogo pelo valor apostado.
 * Real: o saldo vem de depósitos, então o que interessa é o resultado das operações.
 */
function BancaResult({ account, inPlay }: { account: AccountDto; inPlay: number }) {
  const result =
    account.account === 'real'
      ? Number(account.stats.netProfit)
      : Number(account.balance) + inPlay - Number(account.startingBalance)
  const tone = result > 0 ? 'up' : result < 0 ? 'down' : 'muted'
  return (
    <span
      className={`small ${tone}`}
      title={
        account.account === 'real'
          ? 'Resultado das operações fechadas na conta real'
          : `Banca começou com ${formatMoney(account.startingBalance, ACCOUNT_CURRENCY)}`
      }
    >
      {result > 0 ? '+' : ''}
      {formatMoney(result, ACCOUNT_CURRENCY)}{' '}
      {account.account === 'real' ? 'em operações' : 'na banca'}
    </span>
  )
}
