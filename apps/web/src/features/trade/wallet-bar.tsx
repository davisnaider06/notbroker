import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../../lib/api.ts'
import { formatMoney } from '../../lib/format.ts'

export function WalletBar() {
  const { data } = useQuery({ queryKey: queryKeys.portfolio, queryFn: api.portfolio })

  return (
    <div className="wallets">
      {data?.wallets.map((wallet) => (
        <div key={wallet.currency} className="wallet">
          <span className="label">{wallet.currency}</span>
          <strong>{formatMoney(wallet.balance, wallet.currency)}</strong>
          {Number(wallet.locked) > 0 && (
            <span className="muted small">
              + {formatMoney(wallet.locked, wallet.currency)} em ordens
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
