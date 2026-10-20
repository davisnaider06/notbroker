import { ACCOUNT_CURRENCY, type DepositStatus, type WithdrawalStatus } from '@notbroker/contracts'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../../lib/api.ts'
import { formatMoney, formatTime } from '../../lib/format.ts'

const money = (value: string | number) => formatMoney(value, ACCOUNT_CURRENCY)

const DEPOSIT_LABEL: Record<DepositStatus, string> = {
  pending: 'Esperando Pix',
  paid: 'Pago',
  failed: 'Falhou',
  expired: 'Vencido',
  refunded: 'Estornado',
}

const WITHDRAWAL_LABEL: Record<WithdrawalStatus, string> = {
  requested: 'Enviando',
  processing: 'Processando',
  completed: 'Concluído',
  failed: 'Falhou, valor devolvido',
}

interface Row {
  id: string
  kind: 'Depósito' | 'Saque'
  at: string
  amount: number
  status: string
  tone: 'up' | 'down' | ''
  note: string | null
}

/** Depósitos e saques da conta real, mais recentes primeiro. */
export function PaymentsHistory() {
  const payments = useQuery({ queryKey: queryKeys.payments, queryFn: api.payments })
  if (!payments.data) return <p className="muted pad">Carregando…</p>

  const rows: Row[] = [
    ...payments.data.deposits.map((deposit) => ({
      id: deposit.id,
      kind: 'Depósito' as const,
      at: deposit.createdAt,
      amount: Number(deposit.amount),
      status: DEPOSIT_LABEL[deposit.status],
      tone: deposit.status === 'paid' ? ('up' as const) : ('' as const),
      note: null,
    })),
    ...payments.data.withdrawals.map((withdrawal) => ({
      id: withdrawal.id,
      kind: 'Saque' as const,
      at: withdrawal.createdAt,
      amount: -Number(withdrawal.amount),
      status: WITHDRAWAL_LABEL[withdrawal.status],
      tone: withdrawal.status === 'completed' ? ('down' as const) : ('' as const),
      note: withdrawal.failureReason,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  if (rows.length === 0) return <p className="muted pad">Nenhum depósito ou saque ainda.</p>

  return (
    <table>
      <thead>
        <tr>
          <th>Horário</th>
          <th>Tipo</th>
          <th>Valor</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{formatTime(row.at)}</td>
            <td>{row.kind}</td>
            <td className={row.tone}>
              {row.amount > 0 ? '+' : ''}
              {money(row.amount)}
            </td>
            <td title={row.note ?? undefined}>
              {row.status}
              {row.note && <span className="muted small"> · {row.note}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
