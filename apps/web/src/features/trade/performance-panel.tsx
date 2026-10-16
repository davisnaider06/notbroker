import {
  ACCOUNT_CURRENCY,
  type AccountDto,
  BREAKEVEN_WIN_RATE,
  MAX_STARTING_BALANCE,
  MIN_STARTING_BALANCE,
} from '@notbroker/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, queryKeys } from '../../lib/api.ts'
import { formatMoney, formatNumber, formatTime } from '../../lib/format.ts'

const money = (value: string | number) => formatMoney(value, ACCOUNT_CURRENCY)
const percent = (ratio: number) => `${formatNumber(ratio * 100, 1, 1)}%`
const signed = (value: number) => `${value > 0 ? '+' : ''}${money(value)}`
const tone = (value: number) => (value > 0 ? 'up' : value < 0 ? 'down' : '')

const QUICK_BALANCES = ['100', '1000', '10000']

/** Desempenho da banca atual e o botão de começar outra. */
export function PerformancePanel({ openCount }: { openCount: number }) {
  const account = useQuery({ queryKey: queryKeys.account, queryFn: api.account })
  if (!account.data) return <p className="muted pad">Carregando…</p>
  return (
    <div className="performance">
      <Stats account={account.data} />
      <ResetForm openCount={openCount} />
    </div>
  )
}

function Stats({ account }: { account: AccountDto }) {
  const { stats } = account
  const closed = stats.won + stats.lost + stats.draw + stats.refunded
  const decided = stats.won + stats.lost
  const winRate = decided > 0 ? stats.won / decided : null
  const net = Number(stats.netProfit)
  const starting = Number(account.startingBalance)

  return (
    <section>
      <p className="muted small">
        Banca de {money(account.startingBalance)} desde {formatTime(account.startedAt)}
      </p>
      <dl className="stat-grid">
        <div>
          <dt>Resultado</dt>
          <dd className={tone(net)}>
            {signed(net)}
            <span className="stat-note">{starting > 0 ? percent(net / starting) : ''}</span>
          </dd>
        </div>
        <div>
          <dt>Acerto</dt>
          <dd className={winRate === null ? '' : winRate >= BREAKEVEN_WIN_RATE ? 'up' : 'down'}>
            {winRate === null ? '—' : percent(winRate)}
            <span className="stat-note">empata em {percent(BREAKEVEN_WIN_RATE)}</span>
          </dd>
        </div>
        <div>
          <dt>Operações</dt>
          <dd>
            {closed}
            <span className="stat-note">
              {stats.won} win · {stats.lost} loss
              {stats.draw + stats.refunded > 0 && ` · ${stats.draw + stats.refunded} devolvidas`}
            </span>
          </dd>
        </div>
        <div>
          <dt>Volume apostado</dt>
          <dd>
            {money(stats.staked)}
            <span className="stat-note">
              {closed > 0 ? `média ${money(Number(stats.staked) / closed)}` : ''}
            </span>
          </dd>
        </div>
      </dl>
    </section>
  )
}

function ResetForm({ openCount }: { openCount: number }) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('100')
  const [confirming, setConfirming] = useState(false)
  const normalized = text.trim().replace(',', '.')
  const valid =
    /^\d+(\.\d{1,2})?$/.test(normalized) &&
    Number(normalized) >= MIN_STARTING_BALANCE &&
    Number(normalized) <= MAX_STARTING_BALANCE

  const reset = useMutation({
    mutationFn: api.resetAccount,
    onSuccess: (account) => {
      queryClient.setQueryData(queryKeys.account, account)
      void queryClient.invalidateQueries({ queryKey: queryKeys.trades })
      setConfirming(false)
    },
    onError: () => setConfirming(false),
  })

  const choose = (value: string) => {
    setText(value)
    setConfirming(false)
  }

  return (
    <section className="reset-form">
      <h3>Começar banca nova</h3>
      <p className="muted small">
        O saldo passa a ser o valor escolhido e o desempenho volta a zero. O histórico continua na
        aba ao lado.
      </p>
      <div className="reset-row">
        <input
          inputMode="decimal"
          aria-label="Saldo inicial em reais"
          value={text}
          onChange={(event) => choose(event.target.value)}
        />
        {QUICK_BALANCES.map((value) => (
          <button key={value} type="button" className="ghost small" onClick={() => choose(value)}>
            {money(value)}
          </button>
        ))}
      </div>
      {openCount > 0 ? (
        <p className="muted small">
          {openCount === 1
            ? 'Espere a operação aberta fechar.'
            : `Espere as ${openCount} operações abertas fecharem.`}
        </p>
      ) : confirming ? (
        <div className="reset-row">
          <button
            type="button"
            className="primary"
            disabled={reset.isPending}
            onClick={() => reset.mutate({ balance: normalized })}
          >
            Confirmar: zerar e começar com {money(normalized)}
          </button>
          <button type="button" className="ghost" onClick={() => setConfirming(false)}>
            Cancelar
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="ghost"
          disabled={!valid}
          onClick={() => setConfirming(true)}
        >
          Começar com {valid ? money(normalized) : '…'}
        </button>
      )}
      {!valid && (
        <p className="error small">
          Saldo entre {money(MIN_STARTING_BALANCE)} e {money(MAX_STARTING_BALANCE)}
        </p>
      )}
      {reset.isError && <p className="error small">{reset.error.message}</p>}
    </section>
  )
}
