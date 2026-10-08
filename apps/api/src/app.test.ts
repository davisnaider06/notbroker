import type { AccountDto, TradeDto } from '@b-hook/contracts'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createAuth } from './auth/auth.ts'
import { loadEnv } from './config/env.ts'
import { type DatabaseHandle, openDatabase } from './db/client.ts'
import { CATALOG } from './market-data/catalog.ts'
import { MarketDataHub } from './market-data/hub.ts'
import type { MarketDataProvider } from './market-data/provider.ts'
import { syncCatalog } from './trading/accounts.ts'
import { BinaryService } from './trading/binary-service.ts'

const ORIGIN = 'http://localhost:5173'

/** Provedor que não sai para a rede: os preços entram por hub.publish no próprio teste. */
const silentProvider: MarketDataProvider = {
  name: 'test',
  start: () => {},
  candles: async () => [],
  stop: () => {},
}

/** Relógio do teste: começa 10 s depois da virada do minuto, longe do corte de 30 s. */
let clock = Date.UTC(2026, 9, 8, 13, 0, 10)
let app: FastifyInstance
let hub: MarketDataHub
let binaryService: BinaryService
let database: DatabaseHandle
let cookie: string

const advance = (ms: number) => {
  clock += ms
}
const price = (symbol: string, value: string, time = clock) =>
  hub.publish({ symbol, price: value, time })

async function call<T>(method: 'GET' | 'POST', url: string, body?: object) {
  const response = await app.inject({
    method,
    url,
    headers: { cookie, origin: ORIGIN },
    ...(body ? { payload: body } : {}),
  })
  return { status: response.statusCode, body: response.json() as T }
}

async function balance(): Promise<number> {
  const { body } = await call<AccountDto>('GET', '/api/account')
  return Number(body.balance)
}

async function openTrade(symbol: string, direction: 'buy' | 'sell', stake = '100') {
  return call<TradeDto>('POST', '/api/trades', { symbol, direction, stake, expiration: '1m' })
}

/** Leva o relógio até a expiração da operação e liquida. */
async function expire(trade: TradeDto): Promise<TradeDto> {
  clock = Date.parse(trade.expiresAt) + 1
  await binaryService.settleDue()
  const { body } = await call<TradeDto[]>('GET', '/api/trades')
  const settled = body.find((item) => item.id === trade.id)
  if (!settled) throw new Error(`operação ${trade.id} sumiu`)
  return settled
}

beforeAll(async () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'segredo-de-teste-com-mais-de-32-caracteres',
    BETTER_AUTH_URL: ORIGIN,
  })
  database = await openDatabase({ url: undefined, pgliteDir: 'memory://' })
  await syncCatalog(database.db)
  hub = new MarketDataHub({ CRYPTO: silentProvider, US: silentProvider, B3: silentProvider })
  hub.start(CATALOG)
  const auth = createAuth(database.db, env)
  binaryService = new BinaryService(database.db, hub, console, {
    now: () => clock,
    autoSettle: false,
  })
  await binaryService.start()
  /** Câmbio fixo: o teste não sai para a rede. */
  const fx = {
    rates: async () => ({ perUsd: { USD: 1, EUR: 0.9, GBP: 0.8, BRL: 5 }, updatedAt: 0 }),
  }
  app = await buildApp({ auth, hub, fx, binaryService })

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: ORIGIN },
    payload: { name: 'Trader', email: 'trader@example.com', password: 'senha-forte-123' },
  })
  expect(signUp.statusCode).toBe(200)
  cookie = signUp.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
})

afterAll(async () => {
  await app.close()
  await database.close()
})

describe('casa de opções binárias', () => {
  it('bloqueia rotas privadas sem sessão', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/account' })
    expect(response.statusCode).toBe(401)
  })

  it('abre a conta com R$ 10.000', async () => {
    const { body } = await call<AccountDto>('GET', '/api/account')
    expect(body.currency).toBe('BRL')
    expect(Number(body.balance)).toBe(10_000)
  })

  it('recusa operação sem cotação', async () => {
    expect((await openTrade('ETHUSDT', 'buy')).status).toBe(409)
  })

  it('recusa operação com mercado fechado (cotação velha)', async () => {
    price('PETR4', '38.50', clock - 60 * 60_000)
    const { status, body } = await openTrade('PETR4', 'buy')
    expect(status).toBe(409)
    expect(body).toMatchObject({ error: { code: 'MARKET_CLOSED' } })
  })

  it('compra que fecha na alta: win devolve valor + 70%', async () => {
    price('BTCUSDT', '50000')
    const { status, body: trade } = await openTrade('BTCUSDT', 'buy')
    expect(status).toBe(201)
    expect(trade.status).toBe('open')
    // O valor sai do saldo na hora, e o saldo não se mexe com o preço.
    expect(await balance()).toBe(9_900)
    price('BTCUSDT', '50100')
    expect(await balance()).toBe(9_900)

    const settled = await expire(trade)
    expect(settled.status).toBe('won')
    expect(Number(settled.payout)).toBe(170)
    expect(await balance()).toBe(10_070)
  })

  it('compra que fecha na baixa: loss perde o valor', async () => {
    advance(1000)
    price('BTCUSDT', '50000')
    const { body: trade } = await openTrade('BTCUSDT', 'buy')
    price('BTCUSDT', '49900')
    const settled = await expire(trade)
    expect(settled.status).toBe('lost')
    expect(Number(settled.payout)).toBe(0)
    expect(await balance()).toBe(9_970)
  })

  it('venda que fecha na alta é loss; na baixa é win', async () => {
    advance(1000)
    price('ETHUSDT', '3000')
    const { body: loser } = await openTrade('ETHUSDT', 'sell')
    price('ETHUSDT', '3010')
    expect((await expire(loser)).status).toBe('lost')
    expect(await balance()).toBe(9_870)

    advance(1000)
    const { body: winner } = await openTrade('ETHUSDT', 'sell')
    price('ETHUSDT', '2990')
    expect((await expire(winner)).status).toBe('won')
    expect(await balance()).toBe(9_940)
  })

  it('empate devolve o valor', async () => {
    advance(1000)
    price('SOLUSDT', '100')
    const { body: trade } = await openTrade('SOLUSDT', 'buy')
    expect((await expire(trade)).status).toBe('draw')
    expect(await balance()).toBe(9_940)
  })

  it('fecha no preço da expiração, ignorando tick que chegou depois', async () => {
    advance(1000)
    price('XRPUSDT', '1.00')
    const { body: trade } = await openTrade('XRPUSDT', 'buy')
    const expiresAt = Date.parse(trade.expiresAt)
    price('XRPUSDT', '1.10', expiresAt - 500)
    price('XRPUSDT', '0.90', expiresAt + 100)
    const settled = await expire(trade)
    expect(settled.exitPrice).toBe('1.1000000000')
    expect(settled.status).toBe('won')
  })

  it('valida saldo e valor', async () => {
    advance(1000)
    price('BTCUSDT', '50000')
    expect((await openTrade('BTCUSDT', 'buy', '999999')).status).toBe(422)
    // Formato inválido é erro de validação (400); falta de saldo é regra de negócio (422).
    expect((await openTrade('BTCUSDT', 'buy', '10.555')).status).toBe(400)
    expect((await openTrade('BTCUSDT', 'buy', '0.50')).status).toBe(400)
  })
})
