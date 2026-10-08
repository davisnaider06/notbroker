import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, queryKeys } from '../../lib/api.ts'
import { authClient } from '../../lib/auth-client.ts'
import { marketStream, useSubscription } from '../../lib/market-stream.ts'
import { AccountPanel } from './account-panel.tsx'
import { InstrumentList } from './instrument-list.tsx'
import { PriceChart } from './price-chart.tsx'
import { TradeTicket } from './trade-ticket.tsx'
import { WalletBar } from './wallet-bar.tsx'

export function TradeScreen({ user }: { user: { name: string; email: string } }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState('BTCUSDT')
  const instruments = useQuery({ queryKey: queryKeys.instruments, queryFn: api.instruments })

  useEffect(() => {
    marketStream.connect()
    // Abriu ou fechou operação: saldo e lista mudam.
    const stopTrades = marketStream.onTrade(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.trades })
      void queryClient.invalidateQueries({ queryKey: queryKeys.account })
    })
    return () => {
      stopTrades()
      marketStream.disconnect()
    }
  }, [queryClient])

  useSubscription(instruments.data?.map((instrument) => instrument.symbol) ?? [])

  const instrument = instruments.data?.find((item) => item.symbol === selected)

  return (
    <div className="terminal">
      <header className="topbar">
        <span className="brand">B-Hook</span>
        <WalletBar />
        <div className="user">
          <span className="muted">{user.email}</span>
          <button type="button" className="ghost" onClick={() => void authClient.signOut()}>
            Sair
          </button>
        </div>
      </header>

      <aside className="sidebar">
        {instruments.data ? (
          <InstrumentList
            instruments={instruments.data}
            selected={selected}
            onSelect={setSelected}
          />
        ) : (
          <p className="muted pad">Carregando ativos…</p>
        )}
      </aside>

      <main className="workspace">
        {instrument && <PriceChart instrument={instrument} />}
        <AccountPanel instruments={instruments.data ?? []} />
      </main>

      <section className="ticket">{instrument && <TradeTicket instrument={instrument} />}</section>
    </div>
  )
}
