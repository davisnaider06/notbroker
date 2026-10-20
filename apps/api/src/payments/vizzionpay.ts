import type { PixKeyType } from '@notbroker/contracts'
import { z } from 'zod'

/**
 * Cliente HTTP da VizzionPay (https://app.vizzionpay.com.br/docs/v1). Só o que a conta real usa:
 * cobrança Pix, consulta de transação, transferência Pix e consulta de transferência.
 *
 * Os valores vão em reais com decimal (100.5), não em centavos.
 */

/** Status de transação no gateway (consulta e webhook). */
export type ChargeStatus =
  | 'PENDING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REFUNDED'
  | 'CHARGED_BACK'
  | 'EXPIRED'
export type TransferStatus = 'PENDING' | 'PROCESSING' | 'TRANSFERRING' | 'COMPLETED' | 'CANCELED'

export interface PixCharge {
  gatewayId: string
  /** OK, PENDING, FAILED, REJECTED ou CANCELED na resposta da criação. */
  status: string
  pixCode: string
  expiresAt: Date | null
  errorDescription: string | null
}

export interface ChargeLookup {
  gatewayId: string
  clientIdentifier: string | null
  status: ChargeStatus
}

export interface TransferResult {
  gatewayId: string
  status: TransferStatus
  fee: string | null
  rejectedReason: string | null
}

export interface TransferLookup {
  gatewayId: string
  clientIdentifier: string | null
  status: TransferStatus
  rejectedReason: string | null
}

export interface CreatePixChargeInput {
  identifier: string
  amount: string
  client: { name: string; email: string; document: string }
  callbackUrl: string | undefined
}

export interface CreateTransferInput {
  identifier: string
  amount: string
  pix: { type: PixKeyType; key: string }
  owner: { ip: string; name: string; document: string }
  callbackUrl: string | undefined
}

/** Contrato do gateway: os testes trocam por um falso que não sai para a rede. */
export interface PaymentGateway {
  createPixCharge(input: CreatePixChargeInput): Promise<PixCharge>
  getCharge(gatewayId: string): Promise<ChargeLookup | null>
  createTransfer(input: CreateTransferInput): Promise<TransferResult>
  /** Por ID do gateway ou, se o pedido nunca voltou, pelo nosso identificador. */
  getTransfer(query: { gatewayId?: string; identifier?: string }): Promise<TransferLookup | null>
}

/** O gateway respondeu e recusou: o pedido com certeza não foi feito. */
export class GatewayRejectedError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'GatewayRejectedError'
    this.statusCode = statusCode
    this.code = code
  }
}

/**
 * Sem resposta útil: rede, timeout, 5xx ou a página HTML do firewall (bloqueio por região). Em
 * pedido de saída, não dá para saber se o gateway processou: só a consulta posterior decide.
 */
export class GatewayUnavailableError extends Error {
  constructor(detail: string) {
    super(`VizzionPay indisponível: ${detail}`)
    this.name = 'GatewayUnavailableError'
  }
}

const REQUEST_TIMEOUT_MS = 15_000

const errorBodySchema = z.object({
  errorCode: z.string().optional(),
  message: z.string().optional(),
  details: z
    .array(z.object({ path: z.string().optional(), error: z.object({ message: z.string() }) }))
    .optional(),
})

const pixChargeSchema = z.object({
  transactionId: z.string(),
  status: z.string(),
  pix: z.object({ code: z.string(), expiresAt: z.string().nullish() }),
  errorDescription: z.string().nullish(),
})

const chargeLookupSchema = z.object({
  id: z.string(),
  clientIdentifier: z.string().nullish(),
  status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CHARGED_BACK', 'EXPIRED']),
})

const transferStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'TRANSFERRING',
  'COMPLETED',
  'CANCELED',
])

const transferSchema = z.object({
  withdraw: z.object({
    id: z.string(),
    status: transferStatusSchema,
    feeAmount: z.number().nullish(),
    rejectedReason: z.string().nullish(),
  }),
})

const transferLookupSchema = z.object({
  id: z.string(),
  clientIdentifier: z.string().nullish(),
  status: transferStatusSchema,
  rejectedReason: z.string().nullish(),
})

export class VizzionPayGateway implements PaymentGateway {
  readonly #baseUrl: string
  readonly #headers: Record<string, string>

  constructor(options: { baseUrl: string; publicKey: string; secretKey: string }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '')
    this.#headers = {
      'x-public-key': options.publicKey,
      'x-secret-key': options.secretKey,
      accept: 'application/json',
    }
  }

  async createPixCharge(input: CreatePixChargeInput): Promise<PixCharge> {
    const body = await this.#request('POST', '/gateway/pix/receive', {
      identifier: input.identifier,
      amount: Number(input.amount),
      client: input.client,
      products: [
        { id: 'deposito', name: 'Depósito NotBroker', quantity: 1, price: Number(input.amount) },
      ],
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    })
    const parsed = pixChargeSchema.parse(body)
    return {
      gatewayId: parsed.transactionId,
      status: parsed.status,
      pixCode: parsed.pix.code,
      expiresAt: parsed.pix.expiresAt ? new Date(parsed.pix.expiresAt) : null,
      errorDescription: parsed.errorDescription ?? null,
    }
  }

  async getCharge(gatewayId: string): Promise<ChargeLookup | null> {
    const body = await this.#lookup(`/gateway/transactions?id=${encodeURIComponent(gatewayId)}`)
    if (body === null) return null
    const parsed = chargeLookupSchema.parse(body)
    return {
      gatewayId: parsed.id,
      clientIdentifier: parsed.clientIdentifier ?? null,
      status: parsed.status,
    }
  }

  async createTransfer(input: CreateTransferInput): Promise<TransferResult> {
    const body = await this.#request('POST', '/gateway/transfers', {
      identifier: input.identifier,
      amount: Number(input.amount),
      pix: input.pix,
      owner: {
        ip: input.owner.ip,
        name: input.owner.name,
        document: { type: 'cpf', number: input.owner.document },
      },
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    })
    const { withdraw } = transferSchema.parse(body)
    return {
      gatewayId: withdraw.id,
      status: withdraw.status,
      fee: withdraw.feeAmount == null ? null : String(withdraw.feeAmount),
      rejectedReason: withdraw.rejectedReason ?? null,
    }
  }

  async getTransfer(query: {
    gatewayId?: string
    identifier?: string
  }): Promise<TransferLookup | null> {
    const params = query.gatewayId
      ? `id=${encodeURIComponent(query.gatewayId)}`
      : `clientIdentifier=${encodeURIComponent(query.identifier ?? '')}`
    const body = await this.#lookup(`/gateway/transfers?${params}`)
    if (body === null) return null
    const parsed = transferLookupSchema.parse(body)
    return {
      gatewayId: parsed.id,
      clientIdentifier: parsed.clientIdentifier ?? null,
      status: parsed.status,
      rejectedReason: parsed.rejectedReason ?? null,
    }
  }

  /** Consulta que devolve null no 404: o registro não existe no gateway. */
  async #lookup(path: string): Promise<unknown> {
    try {
      return await this.#request('GET', path)
    } catch (error) {
      if (error instanceof GatewayRejectedError && error.statusCode === 404) return null
      throw error
    }
  }

  async #request(method: 'GET' | 'POST', path: string, payload?: object): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: payload ? { ...this.#headers, 'content-type': 'application/json' } : this.#headers,
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new GatewayUnavailableError(error instanceof Error ? error.message : String(error))
    }

    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      // O firewall deles responde HTML quando a origem não é de um país liberado.
      throw new GatewayUnavailableError(
        `resposta não é JSON (HTTP ${response.status}); origem bloqueada por região?`,
      )
    }

    if (response.ok) return body
    if (response.status >= 500 || response.status === 429) {
      throw new GatewayUnavailableError(`HTTP ${response.status}`)
    }
    const error = errorBodySchema.safeParse(body)
    const detail = error.success ? error.data.details?.[0]?.error.message : undefined
    throw new GatewayRejectedError(
      response.status,
      (error.success && error.data.errorCode) || `HTTP_${response.status}`,
      [error.success ? error.data.message : undefined, detail].filter(Boolean).join(': ') ||
        `HTTP ${response.status}`,
    )
  }
}
