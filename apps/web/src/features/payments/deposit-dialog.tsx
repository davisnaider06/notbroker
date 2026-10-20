import {
  ACCOUNT_CURRENCY,
  type DepositDto,
  isValidCpf,
  MAX_DEPOSIT,
  MIN_DEPOSIT,
} from '@notbroker/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, queryKeys } from '../../lib/api.ts'
import { formatCountdown, formatMoney } from '../../lib/format.ts'
import { marketStream } from '../../lib/market-stream.ts'
import { useNow } from '../../lib/use-now.ts'
import { parseAmount } from './amount.ts'
import { Dialog } from './dialog.tsx'

const QUICK_AMOUNTS = ['50', '100', '200', '500']
const money = (value: string | number) => formatMoney(value, ACCOUNT_CURRENCY)

/** Depósito via Pix: escolhe o valor, recebe QR Code + copia e cola, e fecha sozinho quando paga. */
export function DepositDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [amountText, setAmountText] = useState('100')
  const [cpf, setCpf] = useState('')
  const [deposit, setDeposit] = useState<DepositDto | null>(null)

  const amount = parseAmount(amountText, MIN_DEPOSIT, MAX_DEPOSIT)
  const cpfOk = isValidCpf(cpf)

  const create = useMutation({
    mutationFn: api.createDeposit,
    onSuccess: (created) => {
      setDeposit(created)
      void queryClient.invalidateQueries({ queryKey: queryKeys.payments })
    },
  })

  // O webhook do gateway chega pelo WebSocket: o QR some e aparece o crédito.
  useEffect(
    () =>
      marketStream.onPayment(({ deposit: update }) => {
        if (update) setDeposit((current) => (current?.id === update.id ? update : current))
      }),
    [],
  )

  return (
    <Dialog title="Depositar via Pix" onClose={onClose}>
      {deposit ? (
        <PixCharge deposit={deposit} onUpdate={setDeposit} onClose={onClose} />
      ) : (
        <form
          className="payment-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (amount && cpfOk) create.mutate({ amount, document: cpf })
          }}
        >
          <label>
            Valor (R$)
            <input
              inputMode="decimal"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
            />
          </label>
          <div className="stake-chips">
            {QUICK_AMOUNTS.map((value) => (
              <button
                key={value}
                type="button"
                className={`ghost small ${amount === value ? 'active' : ''}`}
                onClick={() => setAmountText(value)}
              >
                {money(value)}
              </button>
            ))}
          </div>
          <label>
            CPF de quem vai pagar
            <input
              inputMode="numeric"
              autoComplete="off"
              placeholder="000.000.000-00"
              value={cpf}
              onChange={(event) => setCpf(event.target.value)}
            />
          </label>
          {!amount && (
            <p className="error small">
              Valor entre {money(MIN_DEPOSIT)} e {money(MAX_DEPOSIT)}, até 2 casas decimais
            </p>
          )}
          {cpf && !cpfOk && <p className="error small">CPF inválido</p>}
          {create.isError && <p className="error small">{create.error.message}</p>}
          <button
            type="submit"
            className="primary"
            disabled={!amount || !cpfOk || create.isPending}
          >
            {create.isPending ? 'Gerando Pix…' : `Gerar Pix de ${amount ? money(amount) : '…'}`}
          </button>
        </form>
      )}
    </Dialog>
  )
}

function PixCharge({
  deposit,
  onUpdate,
  onClose,
}: {
  deposit: DepositDto
  onUpdate: (deposit: DepositDto) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const now = useNow(1000)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!deposit.pixCode) return
    let cancelled = false
    // Carregada só aqui: o gerador de QR não pesa no carregamento do terminal.
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toString(deposit.pixCode, { type: 'svg', margin: 1, width: 220 }),
      )
      .then((svg) => {
        if (!cancelled) setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)
      })
    return () => {
      cancelled = true
    }
  }, [deposit.pixCode])

  useEffect(() => {
    if (deposit.status === 'paid') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts })
      void queryClient.invalidateQueries({ queryKey: queryKeys.payments })
    }
  }, [deposit.status, queryClient])

  const refresh = useMutation({ mutationFn: api.refreshDeposit, onSuccess: onUpdate })

  if (deposit.status === 'paid') {
    return (
      <div className="payment-done">
        <p className="success">Pix recebido: {money(deposit.amount)} na conta real.</p>
        <button type="button" className="primary" onClick={onClose}>
          Operar
        </button>
      </div>
    )
  }
  if (deposit.status !== 'pending') {
    return (
      <div className="payment-done">
        <p className="error">
          {deposit.status === 'expired'
            ? 'O Pix venceu sem pagamento.'
            : 'O gateway não confirmou esse Pix.'}
        </p>
        <button type="button" className="ghost" onClick={onClose}>
          Fechar
        </button>
      </div>
    )
  }

  const expiresIn = deposit.expiresAt ? Date.parse(deposit.expiresAt) - now : null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(deposit.pixCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="pix-charge">
      <p>
        Pague <strong>{money(deposit.amount)}</strong> no app do seu banco.
      </p>
      {qr ? (
        <img className="pix-qr" src={qr} alt="QR Code do Pix" width={220} height={220} />
      ) : (
        <div className="pix-qr placeholder" />
      )}
      <label>
        Pix copia e cola
        <textarea className="pix-code" readOnly rows={3} value={deposit.pixCode} />
      </label>
      <button type="button" className="primary" onClick={() => void copy()}>
        {copied ? 'Copiado' : 'Copiar código'}
      </button>
      {expiresIn !== null && (
        <p className="muted small">
          {expiresIn > 0 ? `Vence em ${formatCountdown(expiresIn)}` : 'Prazo do QR Code acabou'}
        </p>
      )}
      <p className="muted small">
        A confirmação aparece aqui sozinha, em segundos depois do pagamento.
      </p>
      <button
        type="button"
        className="ghost small"
        disabled={refresh.isPending}
        onClick={() => refresh.mutate(deposit.id)}
      >
        {refresh.isPending ? 'Conferindo…' : 'Já paguei, conferir agora'}
      </button>
      {refresh.isError && <p className="error small">{refresh.error.message}</p>}
    </div>
  )
}
