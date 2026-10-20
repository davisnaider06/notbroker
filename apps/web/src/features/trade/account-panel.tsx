import {
  ACCOUNT_CURRENCY,
  type Currency,
  type InstrumentDto,
  previewOutcome,
  type TradeDirection,
  type TradeDto,
  type TradeStatus,
} from '@notbroker/contracts'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useAccountKind } from '../../lib/account-kind.tsx'
import { api, queryKeys } from '../../lib/api.ts'
import { formatCountdown, formatMoney, formatPrice, formatTime } from '../../lib/format.ts'
import { useLivePrice } from '../../lib/market-stream.ts'
import { useNow } from '../../lib/use-now.ts'
import { PaymentsHistory } from '../payments/payments-history.tsx'
import { PerformancePanel } from './performance-panel.tsx'

type Tab = 'open' | 'history' | 'performance' | 'payments'

const DIRECTION_LABEL: Record<TradeDirection, string> = { buy: '▲ Compra', sell: '▼ Venda' }

const RESULT_LABEL: Record<Exclude<TradeStatus, 'open'>, string> = {
  won: 'WIN',
  lost: 'LOSS',
  draw: 'EMPATE',
  refunded: 'ESTORNADA',
}

const money = (value: string | number) => formatMoney(value, ACCOUNT_CURRENCY)

export function AccountPanel({ instruments }: { instruments: InstrumentDto[] }) {
  const [tab, setTab] = useState<Tab>('open')
  const { kind } = useAccountKind()
  const trades = useQuery({ queryKey: queryKeys.trades(kind), queryFn: () => api.trades(kind) })
  // Movimentações só existem na conta real.
  const shown = kind === 'demo' && tab === 'payments' ? 'open' : tab

  const currencyOf = (symbol: string): Currency =>
    instruments.find((instrument) => instrument.symbol === symbol)?.currency ?? 'USD'
  const open = (trades.data ?? []).filter((trade) => trade.status === 'open')
  const history = (trades.data ?? []).filter((trade) => trade.status !== 'open')

  return (
    <section className="account-panel">
      <div className="tabs">
        <button
          type="button"
          className={shown === 'open' ? 'active' : ''}
          onClick={() => setTab('open')}
        >
          Operações abertas ({open.length})
        </button>
        <button
          type="button"
          className={shown === 'history' ? 'active' : ''}
          onClick={() => setTab('history')}
        >
          Histórico
        </button>
        <button
          type="button"
          className={shown === 'performance' ? 'active' : ''}
          onClick={() => setTab('performance')}
        >
          Desempenho
        </button>
        {kind === 'real' && (
          <button
            type="button"
            className={shown === 'payments' ? 'active' : ''}
            onClick={() => setTab('payments')}
          >
            Movimentações
          </button>
        )}
      </div>

      <div className="table-scroll">
        {shown === 'open' &&
          (open.length === 0 ? (
            <p className="muted pad">Nenhuma operação aberta.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Ativo</th>
                  <th>Direção</th>
                  <th>Valor</th>
                  <th>Entrada</th>
                  <th>Atual</th>
                  <th>Fecha em</th>
                  <th>Se fechar agora</th>
                </tr>
              </thead>
              <tbody>
                {open.map((trade) => (
                  <OpenTradeRow key={trade.id} trade={trade} currency={currencyOf(trade.symbol)} />
                ))}
              </tbody>
            </table>
          ))}

        {shown === 'history' &&
          (history.length === 0 ? (
            <p className="muted pad">Nenhuma operação fechada ainda.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Horário</th>
                  <th>Ativo</th>
                  <th>Direção</th>
                  <th>Valor</th>
                  <th>Entrada</th>
                  <th>Saída</th>
                  <th>Resultado</th>
                  <th>Lucro</th>
                </tr>
              </thead>
              <tbody>
                {history.map((trade) => (
                  <HistoryRow key={trade.id} trade={trade} currency={currencyOf(trade.symbol)} />
                ))}
              </tbody>
            </table>
          ))}

        {shown === 'performance' && <PerformancePanel openCount={open.length} />}
        {shown === 'payments' && <PaymentsHistory />}
      </div>
    </section>
  )
}

function OpenTradeRow({ trade, currency }: { trade: TradeDto; currency: Currency }) {
  const live = useLivePrice(trade.symbol)
  const now = useNow(500)
  const stake = Number(trade.stake)
  const situation = live
    ? previewOutcome(trade.direction, Number(trade.entryPrice), live.price)
    : null
  const returnNow =
    situation === 'won' ? stake * (1 + Number(trade.payoutRate)) : situation === 'draw' ? stake : 0

  return (
    <tr>
      <td>{trade.symbol}</td>
      <td className={trade.direction === 'buy' ? 'up' : 'down'}>
        {DIRECTION_LABEL[trade.direction]}
      </td>
      <td>{money(trade.stake)}</td>
      <td>{formatPrice(trade.entryPrice, currency)}</td>
      <td>{live ? formatPrice(live.price, currency) : '—'}</td>
      <td>{formatCountdown(Date.parse(trade.expiresAt) - now)}</td>
      <td className={situation === 'won' ? 'up' : situation === 'lost' ? 'down' : ''}>
        {situation === null
          ? '—'
          : `${situation === 'won' ? 'Ganhando' : situation === 'lost' ? 'Perdendo' : 'Empate'} · ${money(returnNow)}`}
      </td>
    </tr>
  )
}

function HistoryRow({ trade, currency }: { trade: TradeDto; currency: Currency }) {
  const status = trade.status === 'open' ? null : trade.status
  const profit = Number(trade.payout ?? 0) - Number(trade.stake)

  return (
    <tr>
      <td>{formatTime(trade.openedAt)}</td>
      <td>{trade.symbol}</td>
      <td className={trade.direction === 'buy' ? 'up' : 'down'}>
        {DIRECTION_LABEL[trade.direction]}
      </td>
      <td>{money(trade.stake)}</td>
      <td>{formatPrice(trade.entryPrice, currency)}</td>
      <td>{trade.exitPrice ? formatPrice(trade.exitPrice, currency) : '—'}</td>
      <td>{status && <span className={`result-tag ${status}`}>{RESULT_LABEL[status]}</span>}</td>
      <td className={profit > 0 ? 'up' : profit < 0 ? 'down' : ''}>
        {profit > 0 ? '+' : ''}
        {money(profit)}
      </td>
    </tr>
  )
}
