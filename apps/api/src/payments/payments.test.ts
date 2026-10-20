import type {
  AccountDto,
  DepositDto,
  PaymentsDto,
  TradeDto,
  WithdrawalDto,
} from '@notbroker/contracts'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.ts'
import { createAuth } from '../auth/auth.ts'
import { loadEnv } from '../config/env.ts'
import { type DatabaseHandle, openDatabase } from '../db/client.ts'
import { WEBHOOK_PATH } from '../http/routes/payments.ts'
import { CATALOG } from '../market-data/catalog.ts'
import { MarketDataHub } from '../market-data/hub.ts'
import type { MarketDataProvider } from '../market-data/provider.ts'
import { syncCatalog } from '../trading/accounts.ts'
import { BinaryService } from '../trading/binary-service.ts'
import { ipv4Of, PaymentsService, plainName } from './payments-service.ts'
import {
  type ChargeStatus,
  type CreatePixChargeInput,
  type CreateTransferInput,
  GatewayRejectedError,
  GatewayUnavailableError,
  type PaymentGateway,
  type TransferStatus,
} from './vizzionpay.ts'

const ORIGIN = 'http://localhost:5173'
/** CPF de teste com dígitos verificadores válidos. */
const CPF = '529.982.247-25'

interface FakeCharge {
  input: CreatePixChargeInput
  status: ChargeStatus
}
interface FakeTransfer {
  input: CreateTransferInput
  status: TransferStatus
}

/**
 * Gateway falso: guarda cobranças e transferências em memória. O teste decide o status que a
 * consulta devolve, como se o Pix tivesse sido pago (ou não) do lado de lá.
 */
class FakeGateway implements PaymentGateway {
  readonly charges = new Map<string, FakeCharge>()
  readonly transfers = new Map<string, FakeTransfer>()
  lookups = 0
  /** Próxima criação de transferência falha assim. */
  failNextTransfer: Error | undefined

  async createPixCharge(input: CreatePixChargeInput) {
    const gatewayId = `tx_${this.charges.size + 1}`
    this.charges.set(gatewayId, { input, status: 'PENDING' })
    return {
      gatewayId,
      status: 'OK',
      pixCode: `00020101PIX${gatewayId}`,
      expiresAt: new Date(clock + 30 * 60_000),
      errorDescription: null,
    }
  }

  async getCharge(gatewayId: string) {
    this.lookups += 1
    const charge = this.charges.get(gatewayId)
    if (!charge) return null
    return { gatewayId, clientIdentifier: charge.input.identifier, status: charge.status }
  }

  async createTransfer(input: CreateTransferInput) {
    const failure = this.failNextTransfer
    if (failure) {
      this.failNextTransfer = undefined
      throw failure
    }
    const gatewayId = `wd_${this.transfers.size + 1}`
    this.transfers.set(gatewayId, { input, status: 'PENDING' })
    return { gatewayId, status: 'PENDING' as const, fee: '1', rejectedReason: null }
  }

  async getTransfer(query: { gatewayId?: string; identifier?: string }) {
    this.lookups += 1
    for (const [gatewayId, transfer] of this.transfers) {
      if (gatewayId === query.gatewayId || transfer.input.identifier === query.identifier) {
        return {
          gatewayId,
          clientIdentifier: transfer.input.identifier,
          status: transfer.status,
          rejectedReason: transfer.status === 'CANCELED' ? 'Chave Pix inválida' : null,
        }
      }
    }
    return null
  }

  chargeOf(deposit: DepositDto): { gatewayId: string; charge: FakeCharge } {
    for (const [gatewayId, charge] of this.charges) {
      if (charge.input.identifier === deposit.id) return { gatewayId, charge }
    }
    throw new Error(`cobrança do depósito ${deposit.id} não existe`)
  }

  transferOf(withdrawal: WithdrawalDto): { gatewayId: string; transfer: FakeTransfer } {
    for (const [gatewayId, transfer] of this.transfers) {
      if (transfer.input.identifier === withdrawal.id) return { gatewayId, transfer }
    }
    throw new Error(`transferência do saque ${withdrawal.id} não existe`)
  }
}

const silentProvider: MarketDataProvider = {
  name: 'test',
  realtime: true,
  start: () => {},
  candles: async () => [],
  stop: () => {},
}

/** 1 s depois da virada de minuto: dentro da janela de entrada da vela de 1m. */
let clock = Math.ceil(Date.now() / 60_000) * 60_000 + 1_000
let app: FastifyInstance
let database: DatabaseHandle
let gateway: FakeGateway
let payments: PaymentsService
let hub: MarketDataHub
let cookie: string
/** Segundo usuário: os limites por minuto são por usuário, e o teste faz mais pedidos que isso. */
let friend: string

async function call<T>(method: 'GET' | 'POST', url: string, body?: object, as = cookie) {
  const response = await app.inject({
    method,
    url,
    headers: { cookie: as, origin: ORIGIN },
    remoteAddress: '187.10.20.30',
    ...(body ? { payload: body } : {}),
  })
  return { status: response.statusCode, body: response.json() as T }
}

async function realBalance(as = cookie): Promise<number> {
  const { body } = await call<AccountDto>('GET', '/api/account?account=real', undefined, as)
  return Number(body.balance)
}

async function signUp(email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: ORIGIN },
    payload: { name: 'Trader', email, password: 'senha-forte-123' },
  })
  return {
    status: response.statusCode,
    cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
  }
}

/** O gateway avisa que algo mudou; do payload só o identificador é usado. */
const webhook = (payload: object) =>
  app.inject({ method: 'POST', url: WEBHOOK_PATH, payload, remoteAddress: '54.1.2.3' })

async function deposit(amount: string, as = cookie): Promise<DepositDto> {
  const { status, body } = await call<DepositDto>(
    'POST',
    '/api/deposits',
    { amount, document: CPF },
    as,
  )
  expect(status).toBe(201)
  return body
}

async function payDeposit(created: DepositDto): Promise<void> {
  const { gatewayId, charge } = gateway.chargeOf(created)
  charge.status = 'COMPLETED'
  const response = await webhook({
    event: 'TRANSACTION_PAID',
    token: 'qualquer',
    transaction: { id: gatewayId, identifier: created.id },
  })
  expect(response.statusCode).toBe(200)
}

const withdrawal = (amount: string, as = cookie) =>
  call<WithdrawalDto>(
    'POST',
    '/api/withdrawals',
    { amount, name: 'João da Silva', document: CPF, pixKeyType: 'cpf', pixKey: CPF },
    as,
  )

beforeAll(async () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'segredo-de-teste-com-mais-de-32-caracteres',
    BETTER_AUTH_URL: ORIGIN,
    ALLOWED_EMAILS: 'Amigo@Example.com, outro@example.com',
  })
  database = await openDatabase({ url: undefined, pgliteDir: 'memory://' })
  await syncCatalog(database.db)
  hub = new MarketDataHub({ CRYPTO: silentProvider, US: silentProvider, B3: silentProvider })
  hub.start(CATALOG)
  const binaryService = new BinaryService(database.db, hub, console, {
    now: () => clock,
    autoSettle: false,
    entryWaitMs: { CRYPTO: 300, US: 300, B3: 300 },
  })
  await binaryService.start()
  gateway = new FakeGateway()
  payments = new PaymentsService(database.db, gateway, console, {
    callbackUrl: `https://notbroker.example${WEBHOOK_PATH}`,
    now: () => clock,
    autoSweep: false,
  })
  const fx = {
    rates: async () => ({ perUsd: { USD: 1, EUR: 0.9, GBP: 0.8, BRL: 5 }, updatedAt: 0 }),
  }
  app = await buildApp({ auth: createAuth(database.db, env), hub, fx, binaryService, payments })

  const first = await signUp('amigo@example.com')
  const second = await signUp('outro@example.com')
  expect([first.status, second.status]).toEqual([200, 200])
  cookie = first.cookie
  friend = second.cookie
})

afterAll(async () => {
  await app.close()
  await database.close()
})

beforeEach(() => {
  gateway.failNextTransfer = undefined
})

describe('conta real', () => {
  it('cadastro só para e-mails da lista', async () => {
    const response = await signUp('estranho@example.com')
    expect(response.status).toBe(403)
  })

  it('nasce zerada, separada da demo, e não aceita banca nova', async () => {
    expect(await realBalance()).toBe(0)
    const demo = await call<AccountDto>('GET', '/api/account')
    expect(Number(demo.body.balance)).toBe(10_000)

    await call('POST', '/api/account/reset', { balance: '50000' })
    expect(await realBalance()).toBe(0)
  })

  it('depósito gera o Pix copia e cola e fica pendente até o pagamento', async () => {
    const created = await deposit('150')
    expect(created.status).toBe('pending')
    expect(created.pixCode).toMatch(/^00020101PIX/)
    expect(gateway.chargeOf(created).charge.input).toMatchObject({
      identifier: created.id,
      amount: '150',
      client: { email: 'amigo@example.com', document: '52998224725' },
      callbackUrl: `https://notbroker.example${WEBHOOK_PATH}`,
    })
    expect(await realBalance()).toBe(0)
  })

  it('webhook forjado não credita: o status vem da consulta ao gateway', async () => {
    const created = await deposit('80')
    const response = await webhook({
      event: 'TRANSACTION_PAID',
      transaction: { id: gateway.chargeOf(created).gatewayId, identifier: created.id },
    })
    expect(response.statusCode).toBe(200)
    expect(await realBalance()).toBe(0)
  })

  it('Pix pago credita uma vez só, mesmo com webhook repetido', async () => {
    const before = await realBalance()
    const created = await deposit('300')
    await payDeposit(created)
    await payDeposit(created)
    expect(await realBalance()).toBe(before + 300)

    const { body } = await call<PaymentsDto>('GET', '/api/payments')
    expect(body.enabled).toBe(true)
    expect(body.deposits.find((item) => item.id === created.id)?.status).toBe('paid')
  })

  it('"já paguei" consulta o gateway e credita sem webhook', async () => {
    const before = await realBalance()
    const created = await deposit('20')
    gateway.chargeOf(created).charge.status = 'COMPLETED'
    const { body } = await call<DepositDto>('POST', `/api/deposits/${created.id}/refresh`)
    expect(body.status).toBe('paid')
    expect(await realBalance()).toBe(before + 20)
  })

  it('valida CPF e faixa do depósito', async () => {
    const badCpf = await call(
      'POST',
      '/api/deposits',
      { amount: '50', document: '111.111.111-11' },
      friend,
    )
    expect(badCpf.status).toBe(400)
    const tooSmall = await call('POST', '/api/deposits', { amount: '5', document: CPF }, friend)
    expect(tooSmall.status).toBe(400)
    // O segundo usuário fica com saldo para os saques mais abaixo.
    await payDeposit(await deposit('600', friend))
    expect(await realBalance(friend)).toBe(600)
  })

  it('operação na conta real usa o saldo real, não o demo', async () => {
    const realBefore = await realBalance()
    const demoBefore = Number((await call<AccountDto>('GET', '/api/account')).body.balance)
    hub.publish({ symbol: 'BTCUSDT', price: '100', time: clock })
    const feed = setInterval(() => hub.publish({ symbol: 'BTCUSDT', price: '100', time: clock }), 5)
    const { status, body } = await call<TradeDto>('POST', '/api/trades', {
      symbol: 'BTCUSDT',
      direction: 'buy',
      stake: '10',
      expiration: '1m',
      account: 'real',
    }).finally(() => clearInterval(feed))
    expect(status).toBe(201)
    expect(body.account).toBe('real')
    expect(await realBalance()).toBe(realBefore - 10)
    expect(Number((await call<AccountDto>('GET', '/api/account')).body.balance)).toBe(demoBefore)

    const realTrades = await call<TradeDto[]>('GET', '/api/trades?account=real')
    expect(realTrades.body.map((trade) => trade.id)).toEqual([body.id])
  })

  it('saque mínimo de R$ 200', async () => {
    const { status } = await withdrawal('199.99')
    expect(status).toBe(400)
  })

  it('recusa saque maior que o saldo real', async () => {
    const { status, body } = await withdrawal('100000')
    expect(status).toBe(422)
    expect(body).toMatchObject({ error: { code: 'INSUFFICIENT_FUNDS' } })
  })

  it('saque debita na hora e manda o titular sem acento e o IP do usuário', async () => {
    const before = await realBalance()
    const { status, body } = await withdrawal('200')
    expect(status).toBe(201)
    expect(body.status).toBe('processing')
    expect(await realBalance()).toBe(before - 200)
    expect(gateway.transferOf(body).transfer.input.owner).toEqual({
      ip: '187.10.20.30',
      name: 'Joao da Silva',
      document: '52998224725',
    })

    // Um saque por vez.
    const second = await withdrawal('200')
    expect(second.status).toBe(409)
  })

  it('saque cancelado no gateway devolve o valor uma vez só', async () => {
    const before = await realBalance()
    const { body: overview } = await call<PaymentsDto>('GET', '/api/payments')
    const pending = overview.withdrawals[0]
    if (!pending) throw new Error('sem saque')
    const { gatewayId, transfer } = gateway.transferOf(pending)
    transfer.status = 'CANCELED'
    const payload = {
      event: 'TRANSFER_FAILED',
      withdraw: { id: gatewayId, clientIdentifier: pending.id },
    }
    await webhook(payload)
    await webhook(payload)
    expect(await realBalance()).toBe(before + 200)

    const { body } = await call<PaymentsDto>('GET', '/api/payments')
    expect(body.withdrawals[0]).toMatchObject({
      status: 'failed',
      failureReason: 'Chave Pix inválida',
    })
  })

  it('saque recusado na criação devolve o valor', async () => {
    const before = await realBalance(friend)
    gateway.failNextTransfer = new GatewayRejectedError(
      400,
      'GATEWAY_INVALID_ARGUMENT',
      'O documento do proprietário não corresponde à chave Pix.',
    )
    const { status, body } = await withdrawal('200', friend)
    expect(status).toBe(422)
    expect(body).toMatchObject({ error: { code: 'WITHDRAWAL_REJECTED' } })
    expect(await realBalance(friend)).toBe(before)
  })

  it('saque sem resposta fica preso até a consulta; se não chegou lá, volta', async () => {
    const before = await realBalance(friend)
    gateway.failNextTransfer = new GatewayUnavailableError('timeout')
    const { status, body } = await withdrawal('200', friend)
    expect(status).toBe(201)
    expect(body.status).toBe('requested')
    expect(await realBalance(friend)).toBe(before - 200)

    // Antes do prazo, a consulta não acha e espera.
    clock += 6 * 60_000
    await payments.sweep()
    expect(await realBalance(friend)).toBe(before - 200)

    clock += 15 * 60_000
    await payments.sweep()
    expect(await realBalance(friend)).toBe(before)
  })

  it('saque concluído no gateway fecha sem mexer no saldo', async () => {
    const { body } = await withdrawal('200', friend)
    const after = await realBalance(friend)
    const { gatewayId, transfer } = gateway.transferOf(body)
    transfer.status = 'COMPLETED'
    await webhook({ event: 'TRANSFER_COMPLETED', withdraw: { id: gatewayId } })
    expect(await realBalance(friend)).toBe(after)
    const { body: overview } = await call<PaymentsDto>('GET', '/api/payments', undefined, friend)
    expect(overview.withdrawals[0]?.status).toBe('completed')
  })

  it('o sweeper não consulta o mesmo registro antes do intervalo', async () => {
    await payments.sweep()
    const lookups = gateway.lookups
    await payments.sweep()
    expect(gateway.lookups).toBe(lookups)
  })

  it('webhook com formato desconhecido é aceito e ignorado', async () => {
    const response = await webhook({ qualquer: 'coisa' })
    expect(response.statusCode).toBe(200)
  })
})

describe('regras do gateway', () => {
  it('só aceita IPv4', () => {
    expect(ipv4Of('187.10.20.30')).toBe('187.10.20.30')
    expect(ipv4Of('::ffff:187.10.20.30')).toBe('187.10.20.30')
    expect(ipv4Of('2804:14c::1')).toBeNull()
  })

  it('tira acento e símbolo do nome do titular', () => {
    expect(plainName("  Conceição D'Ávila-Souza ")).toBe('Conceicao DAvilaSouza')
  })
})
