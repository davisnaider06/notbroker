import type { InstrumentDto, OrderDto, PositionDto } from '@b-hook/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, queryKeys } from '../../lib/api.ts'
import { formatMoney, formatPrice, formatQuantity, formatTime } from '../../lib/format.ts'
import { useLivePrice } from '../../lib/market-stream.ts'

type Tab = 'positions' | 'open' | 'history'

const SIDE_LABEL = { buy: 'Compra', sell: 'Venda' } as const
const TYPE_LABEL = { market: 'Mercado', limit: 'Limitada' } as const
const STATUS_LABEL = { open: 'Aberta', filled: 'Executada', canceled: 'Cancelada' } as const

export function AccountPanel({ instruments }: { instruments: InstrumentDto[] }) {
  const [tab, setTab] = useState<Tab>('positions')
  const portfolio = useQuery({ queryKey: queryKeys.portfolio, queryFn: api.portfolio })
  const orders = useQuery({ queryKey: queryKeys.orders, queryFn: api.orders })

  const decimalsOf = (symbol: string) =>
    instruments.find((instrument) => instrument.symbol === symbol)?.quantityDecimals ?? 8
  const positions = (portfolio.data?.positions ?? []).filter(
    (position) => Number(position.quantity) > 0 || Number(position.realizedPnl) !== 0,
  )
  const openOrders = (orders.data ?? []).filter((order) => order.status === 'open')
  const history = (orders.data ?? []).filter((order) => order.status !== 'open')

  return (
    <section className="account-panel">
      <div className="tabs">
        <button
          type="button"
          className={tab === 'positions' ? 'active' : ''}
          onClick={() => setTab('positions')}
        >
          Posições ({positions.filter((p) => Number(p.quantity) > 0).length})
        </button>
        <button
          type="button"
          className={tab === 'open' ? 'active' : ''}
          onClick={() => setTab('open')}
        >
          Ordens abertas ({openOrders.length})
        </button>
        <button
          type="button"
          className={tab === 'history' ? 'active' : ''}
          onClick={() => setTab('history')}
        >
          Histórico
        </button>
      </div>

      <div className="table-scroll">
        {tab === 'positions' && (
          <table>
            <thead>
              <tr>
                <th>Ativo</th>
                <th>Qtd.</th>
                <th>Preço médio</th>
                <th>Último</th>
                <th>Resultado aberto</th>
                <th>Realizado</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <PositionRow
                  key={position.symbol}
                  position={position}
                  decimals={decimalsOf(position.symbol)}
                />
              ))}
            </tbody>
          </table>
        )}
        {tab !== 'positions' && (
          <OrdersTable
            orders={tab === 'open' ? openOrders : history}
            decimalsOf={decimalsOf}
            cancellable={tab === 'open'}
          />
        )}
      </div>
    </section>
  )
}

function PositionRow({ position, decimals }: { position: PositionDto; decimals: number }) {
  const live = useLivePrice(position.symbol)
  const quantity = Number(position.quantity)
  const unrealized =
    live && quantity > 0 ? (live.price - Number(position.averagePrice)) * quantity : null
  const realized = Number(position.realizedPnl)

  return (
    <tr>
      <td>{position.symbol}</td>
      <td>{formatQuantity(position.quantity, decimals)}</td>
      <td>{quantity > 0 ? formatPrice(position.averagePrice, position.currency) : '—'}</td>
      <td>{live ? formatPrice(live.price, position.currency) : '—'}</td>
      <td className={pnlClass(unrealized)}>
        {unrealized === null ? '—' : formatMoney(unrealized, position.currency)}
      </td>
      <td className={pnlClass(realized)}>{formatMoney(realized, position.currency)}</td>
    </tr>
  )
}

function OrdersTable({
  orders,
  decimalsOf,
  cancellable,
}: {
  orders: OrderDto[]
  decimalsOf: (symbol: string) => number
  cancellable: boolean
}) {
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: api.cancelOrder,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders })
      void queryClient.invalidateQueries({ queryKey: queryKeys.portfolio })
    },
  })

  if (orders.length === 0) return <p className="muted pad">Nada por aqui ainda.</p>

  return (
    <table>
      <thead>
        <tr>
          <th>Data</th>
          <th>Ativo</th>
          <th>Lado</th>
          <th>Tipo</th>
          <th>Qtd.</th>
          <th>Limite</th>
          <th>Executado a</th>
          <th>Taxa</th>
          <th>Status</th>
          {cancellable && <th />}
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id}>
            <td>{formatTime(order.filledAt ?? order.createdAt)}</td>
            <td>{order.symbol}</td>
            <td className={order.side === 'buy' ? 'up' : 'down'}>{SIDE_LABEL[order.side]}</td>
            <td>{TYPE_LABEL[order.type]}</td>
            <td>{formatQuantity(order.quantity, decimalsOf(order.symbol))}</td>
            <td>{order.limitPrice ? formatPrice(order.limitPrice, order.currency) : '—'}</td>
            <td>{order.fillPrice ? formatPrice(order.fillPrice, order.currency) : '—'}</td>
            <td>{order.fee ? formatMoney(order.fee, order.currency) : '—'}</td>
            <td>{STATUS_LABEL[order.status]}</td>
            {cancellable && (
              <td>
                <button
                  type="button"
                  className="ghost small"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(order.id)}
                >
                  Cancelar
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function pnlClass(value: number | null): string {
  if (value === null || value === 0) return ''
  return value > 0 ? 'up' : 'down'
}
