import {
  type InstrumentDto,
  MARKET_FEE_RATES,
  type OrderSide,
  type OrderType,
  type PlaceOrderInput,
} from '@b-hook/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { api, queryKeys } from '../../lib/api.ts'
import { formatMoney, formatPrice, formatQuantity } from '../../lib/format.ts'
import { useLivePrice } from '../../lib/market-stream.ts'

export function OrderTicket({ instrument }: { instrument: InstrumentDto }) {
  const queryClient = useQueryClient()
  const [side, setSide] = useState<OrderSide>('buy')
  const [type, setType] = useState<OrderType>('market')
  const [quantity, setQuantity] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const live = useLivePrice(instrument.symbol)
  const portfolio = useQuery({ queryKey: queryKeys.portfolio, queryFn: api.portfolio })

  const wallet = portfolio.data?.wallets.find((item) => item.currency === instrument.currency)
  const position = portfolio.data?.positions.find((item) => item.symbol === instrument.symbol)
  const availableQuantity = position
    ? Number(position.quantity) - Number(position.lockedQuantity)
    : 0

  const referencePrice =
    type === 'limit' ? Number(limitPrice) : (live?.price ?? Number(instrument.lastPrice ?? 0))
  const notional = Number(quantity) * referencePrice
  const fee = notional * Number(MARKET_FEE_RATES[instrument.market])

  const placeOrder = useMutation({
    mutationFn: (input: PlaceOrderInput) => api.placeOrder(input),
    onSuccess: (order) => {
      setFeedback({
        kind: 'ok',
        text:
          order.status === 'filled'
            ? `Executada a ${formatPrice(order.fillPrice ?? 0, order.currency)}`
            : 'Ordem limitada aberta',
      })
      setQuantity('')
      void queryClient.invalidateQueries({ queryKey: queryKeys.portfolio })
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders })
    },
    onError: (error) => setFeedback({ kind: 'error', text: error.message }),
  })

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setFeedback(null)
    placeOrder.mutate({
      symbol: instrument.symbol,
      side,
      type,
      quantity,
      ...(type === 'limit' ? { limitPrice } : {}),
    })
  }

  const step =
    instrument.quantityDecimals === 0 ? '1' : `0.${'0'.repeat(instrument.quantityDecimals - 1)}1`

  return (
    <form className="order-ticket" onSubmit={handleSubmit}>
      <div className="segmented wide">
        <button
          type="button"
          className={side === 'buy' ? 'active buy' : ''}
          onClick={() => setSide('buy')}
        >
          Comprar
        </button>
        <button
          type="button"
          className={side === 'sell' ? 'active sell' : ''}
          onClick={() => setSide('sell')}
        >
          Vender
        </button>
      </div>

      <div className="segmented wide">
        <button
          type="button"
          className={type === 'market' ? 'active' : ''}
          onClick={() => setType('market')}
        >
          A mercado
        </button>
        <button
          type="button"
          className={type === 'limit' ? 'active' : ''}
          onClick={() => setType('limit')}
        >
          Limitada
        </button>
      </div>

      <p className="muted small">
        Disponível:{' '}
        {side === 'buy'
          ? wallet
            ? formatMoney(wallet.balance, wallet.currency)
            : '—'
          : `${formatQuantity(availableQuantity, instrument.quantityDecimals)} ${instrument.symbol}`}
      </p>

      {type === 'limit' && (
        <label>
          Preço limite ({instrument.currency})
          <input
            inputMode="decimal"
            value={limitPrice}
            onChange={(event) => setLimitPrice(event.target.value.replace(',', '.'))}
            placeholder={live ? String(live.price) : ''}
            required
          />
        </label>
      )}

      <label>
        Quantidade
        <input
          type="number"
          min={step}
          step={step}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          required
        />
      </label>

      <dl className="summary">
        <dt>Valor estimado</dt>
        <dd>{notional > 0 ? formatMoney(notional, instrument.currency) : '—'}</dd>
        <dt>Taxa ({Number(MARKET_FEE_RATES[instrument.market]) * 100}%)</dt>
        <dd>{notional > 0 ? formatMoney(fee, instrument.currency) : '—'}</dd>
      </dl>

      <button
        type="submit"
        className={`primary ${side}`}
        disabled={placeOrder.isPending || !quantity}
      >
        {side === 'buy' ? 'Comprar' : 'Vender'} {instrument.symbol}
      </button>

      {feedback && <p className={feedback.kind === 'ok' ? 'success' : 'error'}>{feedback.text}</p>}
    </form>
  )
}
