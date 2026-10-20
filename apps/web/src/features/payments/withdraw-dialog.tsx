import {
  ACCOUNT_CURRENCY,
  isValidCpf,
  MIN_WITHDRAWAL,
  PIX_KEY_TYPES,
  type PixKeyType,
  type WithdrawalDto,
} from '@notbroker/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, queryKeys } from '../../lib/api.ts'
import { formatMoney } from '../../lib/format.ts'
import { marketStream } from '../../lib/market-stream.ts'
import { parseAmount } from './amount.ts'
import { Dialog } from './dialog.tsx'

const money = (value: string | number) => formatMoney(value, ACCOUNT_CURRENCY)

const KEY_LABEL: Record<PixKeyType, string> = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  phone: 'Celular',
  email: 'E-mail',
  random: 'Aleatória',
}

/** Saque via Pix da conta real. O valor sai do saldo no pedido e volta se o gateway recusar. */
export function WithdrawDialog({ balance, onClose }: { balance: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [amountText, setAmountText] = useState(String(MIN_WITHDRAWAL))
  const [name, setName] = useState('')
  const [cpf, setCpf] = useState('')
  const [keyType, setKeyType] = useState<PixKeyType>('cpf')
  const [pixKey, setPixKey] = useState('')
  const [result, setResult] = useState<WithdrawalDto | null>(null)

  const amount = parseAmount(amountText, MIN_WITHDRAWAL)
  const overBalance = amount !== null && Number(amount) > Number(balance)
  const cpfOk = isValidCpf(cpf)
  // Chave CPF é o próprio CPF do titular: não precisa digitar duas vezes.
  const key = keyType === 'cpf' ? cpf : pixKey
  const ready = amount && !overBalance && name.trim().length >= 3 && cpfOk && key.trim()

  const withdraw = useMutation({
    mutationFn: api.createWithdrawal,
    onSuccess: (created) => setResult(created),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts })
      void queryClient.invalidateQueries({ queryKey: queryKeys.payments })
    },
  })

  useEffect(
    () =>
      marketStream.onPayment(({ withdrawal: update }) => {
        if (update) setResult((current) => (current?.id === update.id ? update : current))
      }),
    [],
  )

  if (result) {
    return (
      <Dialog title="Sacar via Pix" onClose={onClose}>
        <div className="payment-done">
          {result.status === 'completed' && (
            <p className="success">Saque de {money(result.amount)} enviado.</p>
          )}
          {result.status === 'failed' && (
            <p className="error">
              Saque não saiu: {result.failureReason ?? 'recusado pelo gateway'}. O valor voltou ao
              saldo.
            </p>
          )}
          {(result.status === 'requested' || result.status === 'processing') && (
            <p>
              Saque de <strong>{money(result.amount)}</strong> em processamento. O valor já saiu do
              saldo; se o gateway recusar, ele volta.
            </p>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            Fechar
          </button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Sacar via Pix" onClose={onClose}>
      <form
        className="payment-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && amount) {
            withdraw.mutate({ amount, name, document: cpf, pixKeyType: keyType, pixKey: key })
          }
        }}
      >
        <p className="muted small">
          Saldo real: <strong>{money(balance)}</strong> · mínimo {money(MIN_WITHDRAWAL)}
        </p>
        <label>
          Valor (R$)
          <input
            inputMode="decimal"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
          />
        </label>
        <label>
          Nome completo do titular
          <input
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          CPF do titular
          <input
            inputMode="numeric"
            autoComplete="off"
            placeholder="000.000.000-00"
            value={cpf}
            onChange={(event) => setCpf(event.target.value)}
          />
        </label>
        <div className="field">
          <span>Tipo de chave Pix</span>
          <div className="segmented wide">
            {PIX_KEY_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className={type === keyType ? 'active' : ''}
                onClick={() => setKeyType(type)}
              >
                {KEY_LABEL[type]}
              </button>
            ))}
          </div>
        </div>
        {keyType !== 'cpf' && (
          <label>
            Chave Pix
            <input
              autoComplete="off"
              value={pixKey}
              onChange={(event) => setPixKey(event.target.value)}
            />
          </label>
        )}
        <p className="muted small">
          A chave precisa estar no CPF do titular. O gateway desconta a taxa de saque do valor
          recebido.
        </p>
        {!amount && (
          <p className="error small">Mínimo {money(MIN_WITHDRAWAL)}, até 2 casas decimais</p>
        )}
        {overBalance && <p className="error small">Valor maior que o saldo real</p>}
        {cpf && !cpfOk && <p className="error small">CPF inválido</p>}
        {withdraw.isError && <p className="error small">{withdraw.error.message}</p>}
        <button type="submit" className="primary" disabled={!ready || withdraw.isPending}>
          {withdraw.isPending ? 'Enviando…' : `Sacar ${amount ? money(amount) : '…'}`}
        </button>
      </form>
    </Dialog>
  )
}
