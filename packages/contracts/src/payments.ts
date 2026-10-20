import { z } from 'zod'

/**
 * Regras do dinheiro real (conta `real`). Depósito e saque via Pix pela VizzionPay; o saldo real
 * só sobe com depósito confirmado pelo gateway.
 */
export const MIN_DEPOSIT = 10
export const MAX_DEPOSIT = 5_000
export const MIN_WITHDRAWAL = 200

/** pending: QR gerado, esperando o Pix. paid: creditado. refunded: pago e depois estornado. */
export const DEPOSIT_STATUSES = ['pending', 'paid', 'failed', 'expired', 'refunded'] as const
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number]

/**
 * requested: saldo debitado, pedido ainda sem resposta do gateway. processing: aceito pelo gateway.
 * failed: recusado ou cancelado, valor devolvido ao saldo.
 */
export const WITHDRAWAL_STATUSES = ['requested', 'processing', 'completed', 'failed'] as const
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number]

export const PIX_KEY_TYPES = ['cpf', 'cnpj', 'phone', 'email', 'random'] as const
export type PixKeyType = (typeof PIX_KEY_TYPES)[number]

/** CPF com dígitos verificadores válidos. Aceita com ou sem pontuação. */
export function isValidCpf(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false
  const check = (length: number) => {
    let total = 0
    for (let index = 0; index < length; index++) {
      total += Number(digits[index]) * (length + 1 - index)
    }
    const rest = (total * 10) % 11
    return rest === 10 ? 0 : rest
  }
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10])
}

const cpfSchema = z
  .string()
  .trim()
  .refine(isValidCpf, 'CPF inválido')
  .transform((value) => value.replace(/\D/g, ''))

/** Valor em reais com até 2 casas, como string: nunca passa por float. */
const amountSchema = (min: number, max?: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'valor deve ter no máximo 2 casas decimais')
    .refine((value) => Number(value) >= min, `valor mínimo é R$ ${min}`)
    .refine(
      (value) => max === undefined || Number(value) <= max,
      `valor máximo é R$ ${max?.toLocaleString('pt-BR')}`,
    )

export const createDepositSchema = z.object({
  amount: amountSchema(MIN_DEPOSIT, MAX_DEPOSIT),
  document: cpfSchema,
})
export type CreateDepositInput = z.infer<typeof createDepositSchema>

export const createWithdrawalSchema = z.object({
  amount: amountSchema(MIN_WITHDRAWAL),
  /** Titular da conta que recebe. O gateway confere com o documento da chave Pix. */
  name: z.string().trim().min(3, 'informe o nome completo').max(100),
  document: cpfSchema,
  pixKeyType: z.enum(PIX_KEY_TYPES),
  pixKey: z.string().trim().min(1, 'informe a chave Pix').max(140),
})
export type CreateWithdrawalInput = z.infer<typeof createWithdrawalSchema>

export interface DepositDto {
  id: string
  amount: string
  status: DepositStatus
  /** Pix copia e cola; o QR Code é desenhado a partir dele. */
  pixCode: string
  expiresAt: string | null
  createdAt: string
  paidAt: string | null
}

export interface WithdrawalDto {
  id: string
  amount: string
  /** Taxa do gateway, descontada de quem recebe. Conhecida depois que o gateway aceita. */
  fee: string | null
  status: WithdrawalStatus
  pixKeyType: PixKeyType
  pixKey: string
  failureReason: string | null
  createdAt: string
  completedAt: string | null
}

export interface PaymentsDto {
  /** false quando o servidor está sem as chaves do gateway: a conta real fica indisponível. */
  enabled: boolean
  deposits: DepositDto[]
  withdrawals: WithdrawalDto[]
}
