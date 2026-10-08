import {
  ACCOUNT_CURRENCY,
  EXPIRATIONS,
  type Expiration,
  expiryFor,
  type InstrumentDto,
  MARKET_DATA_DELAY_MINUTES,
  MIN_STAKE,
  PAYOUT_RATE,
  type TradeDirection,
  type TradeDto,
} from '@b-hook/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, queryKeys } from '../../lib/api.ts'
import { formatCountdown, formatMoney, formatNumber, formatPrice } from '../../lib/format.ts'
import { marketStream } from '../../lib/market-stream.ts'
import { useNow } from '../../lib/use-now.ts'

const QUICK_STAKES = ['10', '50', '100', '500']
const PAYOUT_PERCENT = Math.round(Number(PAYOUT_RATE) * 100)

const DIRECTION_LABEL: Record<TradeDirection, string> = { buy: 'Compra', sell: 'Venda' }

const money = (value: string | number) => formatMoney(value, ACCOUNT_CURRENCY)

/** Valor digitado em reais, aceitando vírgula. null quando não é um valor válido. */
function parseStake(text: string): string | null {
  const normalized = text.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  return Number(normalized) >= MIN_STAKE ? normalized : null
}

export function TradeTicket({ instrument }: { instrument: InstrumentDto }) {
  const queryClient = useQueryClient()
  const [stakeText, setStakeText] = useState('100')
  const [expiration, setExpiration] = useState<Expiration>('1m')
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [lastResult, setLastResult] = useState<TradeDto | null>(null)
  const now = useNow(250)
  const account = useQuery({ queryKey: queryKeys.account, queryFn: api.account })

  // Resultado da última operação que fechou, venha ela de qual ativo vier.
  useEffect(
    () =>
      marketStream.onTrade((trade) => {
        if (trade.status !== 'open') setLastResult(trade)
      }),
    [],
  )

  const stake = parseStake(stakeText)
  const profit = stake ? Number(stake) * Number(PAYOUT_RATE) : 0
  const expiresAt = expiryFor(now, expiration)

  const openTrade = useMutation({
    mutationFn: api.openTrade,
    onSuccess: (trade) => {
      setFeedback({
        kind: 'ok',
        text: `${DIRECTION_LABEL[trade.direction]} aberta a ${formatPrice(trade.entryPrice, instrument.currency)}`,
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.account })
      void queryClient.invalidateQueries({ queryKey: queryKeys.trades })
    },
    onError: (error) => setFeedback({ kind: 'error', text: error.message }),
  })

  function submit(direction: TradeDirection) {
    if (!stake) return
    setFeedback(null)
    openTrade.mutate({ symbol: instrument.symbol, direction, stake, expiration })
  }

  return (
    <div className="order-ticket">
      <p className="muted small">
        Saldo: <strong>{account.data ? money(account.data.balance) : '—'}</strong>
      </p>

      <label>
        Valor (R$)
        <input
          inputMode="decimal"
          value={stakeText}
          onChange={(event) => setStakeText(event.target.value)}
        />
      </label>
      <div className="stake-chips">
        {QUICK_STAKES.map((value) => (
          <button
            key={value}
            type="button"
            className="ghost small"
            onClick={() => setStakeText(value)}
          >
            R$ {value}
          </button>
        ))}
      </div>

      <div className="field">
        <span>Expiração</span>
        <div className="segmented wide">
          {EXPIRATIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={option === expiration ? 'active' : ''}
              onClick={() => setExpiration(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <dl className="summary">
        <dt>Fecha às</dt>
        <dd>
          {new Date(expiresAt).toLocaleTimeString('pt-BR')} ({formatCountdown(expiresAt - now)})
        </dd>
        <dt>Payout</dt>
        <dd>{PAYOUT_PERCENT}%</dd>
        <dt>Lucro se acertar</dt>
        <dd className="up">{stake ? `+${money(profit)}` : '—'}</dd>
        <dt>Retorno total</dt>
        <dd>{stake ? money(Number(stake) + profit) : '—'}</dd>
      </dl>

      {MARKET_DATA_DELAY_MINUTES[instrument.market] > 0 && (
        <p className="delay-warning">
          Cotação da {instrument.market} com {MARKET_DATA_DELAY_MINUTES[instrument.market]} min de
          atraso: a operação abre e fecha nesse preço, não no da bolsa agora.
        </p>
      )}

      <div className="direction-buttons">
        <button
          type="button"
          className="primary buy"
          disabled={!stake || openTrade.isPending}
          onClick={() => submit('buy')}
        >
          ▲ Compra
          <span className="small">fecha acima</span>
        </button>
        <button
          type="button"
          className="primary sell"
          disabled={!stake || openTrade.isPending}
          onClick={() => submit('sell')}
        >
          ▼ Venda
          <span className="small">fecha abaixo</span>
        </button>
      </div>

      {!stake && <p className="error small">Valor mínimo R$ {MIN_STAKE}, até 2 casas decimais</p>}
      {feedback && <p className={feedback.kind === 'ok' ? 'success' : 'error'}>{feedback.text}</p>}
      {lastResult && <ResultBanner trade={lastResult} />}
    </div>
  )
}

function ResultBanner({ trade }: { trade: TradeDto }) {
  const net = Number(trade.payout ?? 0) - Number(trade.stake)
  const text = {
    won: `WIN +${money(net)}`,
    lost: `LOSS −${money(trade.stake)}`,
    draw: 'EMPATE · valor devolvido',
    refunded: 'ESTORNADA · valor devolvido',
    open: '',
  }[trade.status]
  const tone = trade.status === 'won' ? 'up' : trade.status === 'lost' ? 'down' : 'flat'

  return (
    <div className={`result-banner ${tone}`}>
      <strong>{text}</strong>
      <span className="small">
        {DIRECTION_LABEL[trade.direction]} {trade.symbol} · entrada {formatNumber(trade.entryPrice)}{' '}
        → saída {trade.exitPrice ? formatNumber(trade.exitPrice) : '—'}
      </span>
    </div>
  )
}
