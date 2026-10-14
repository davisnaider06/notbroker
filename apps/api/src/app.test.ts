import {
  type AccountDto,
  type InstrumentDto,
  MAX_OPEN_TRADES,
  type TradeDto,
} from '@notbroker/contracts'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { createAuth } from './auth/auth.ts'
import { loadEnv } from './config/env.ts'
import { type DatabaseHandle, openDatabase } from './db/client.ts'
import { TRADE_RATE_LIMIT } from './http/routes/trading.ts'
import { CATALOG } from './market-data/catalog.ts'
import { MarketDataHub } from './market-data/hub.ts'
import type { MarketDataProvider } from './market-data/provider.ts'
import { syncCatalog } from './trading/accounts.ts'
import { BinaryService } from './trading/binary-service.ts'

const ORIGIN = 'http://localhost:5173'

/** Provedor que não sai para a rede: os preços entram por hub.publish no próprio teste. */
const silentProvider: MarketDataProvider = {
  name: 'test',
  realtime: true,
  start: () => {},
  candles: async () => [],
  stop: () => {},
}
/** Como o Yahoo na B3: polling com atraso, só para gráfico. */
const delayedProvider: MarketDataProvider = { ...silentProvider, name: 'delayed', realtime: false }

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

async function call<T>(method: 'GET' | 'POST', url: string, body?: object, as = cookie) {
  const response = await app.inject({
    method,
    url,
    headers: { cookie: as, origin: ORIGIN },
    ...(body ? { payload: body } : {}),
  })
  return { status: response.statusCode, body: response.json() as T }
}

async function balance(): Promise<number> {
  const { body } = await call<AccountDto>('GET', '/api/account')
  return Number(body.balance)
}

async function openTrade(symbol: string, direction: 'buy' | 'sell', stake = '100', as = cookie) {
  return call<TradeDto>('POST', '/api/trades', { symbol, direction, stake, expiration: '1m' }, as)
}

/** Negócio 1 s antes da expiração: é o preço vigente quando a operação fecha. */
const priceAtExpiry = (trade: TradeDto, value: string) =>
  price(trade.symbol, value, Date.parse(trade.expiresAt) - 1000)

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: ORIGIN },
    payload: { name: 'Trader', email, password: 'senha-forte-123' },
  })
  expect(response.statusCode).toBe(200)
  return response.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
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
  hub = new MarketDataHub({ CRYPTO: silentProvider, US: silentProvider, B3: delayedProvider })
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

  cookie = await signUp('trader@example.com')
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

  it('B3 com cotação atrasada fica só no gráfico, mesmo com tick novo', async () => {
    price('PETR4', '38.50')
    const { status, body } = await openTrade('PETR4', 'buy')
    expect(status).toBe(409)
    expect(body).toMatchObject({ error: { code: 'MARKET_DELAYED' } })

    const instruments = await app.inject({ method: 'GET', url: '/api/instruments' })
    const tradable = Object.fromEntries(
      instruments.json<InstrumentDto[]>().map((item) => [item.symbol, item.tradable]),
    )
    expect(tradable).toMatchObject({ PETR4: false, BTCUSDT: true, AAPL: true })
  })

  it('recusa entrada em cotação parada: preço velho é resultado conhecido', async () => {
    price('BNBUSDT', '600', clock - 6000)
    const { status, body } = await openTrade('BNBUSDT', 'buy')
    expect(status).toBe(409)
    expect(body).toMatchObject({ error: { code: 'MARKET_CLOSED' } })
    expect(await balance()).toBe(10_000)
  })

  it('estorna quando o feed estava parado na expiração', async () => {
    price('BNBUSDT', '600')
    const { status, body: trade } = await openTrade('BNBUSDT', 'buy')
    expect(status).toBe(201)
    // Último negócio 30 s antes da expiração: não é o preço daquele instante.
    price('BNBUSDT', '650', Date.parse(trade.expiresAt) - 30_000)
    const settled = await expire(trade)
    expect(settled.status).toBe('refunded')
    expect(settled.exitPrice).toBeNull()
    expect(await balance()).toBe(10_000)
  })

  it('compra que fecha na alta: win devolve valor + 70%', async () => {
    price('BTCUSDT', '50000')
    const { status, body: trade } = await openTrade('BTCUSDT', 'buy')
    expect(status).toBe(201)
    expect(trade.status).toBe('open')
    // O valor sai do saldo na hora, e o saldo não se mexe com o preço.
    expect(await balance()).toBe(9_900)
    priceAtExpiry(trade, '50100')
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
    priceAtExpiry(trade, '49900')
    const settled = await expire(trade)
    expect(settled.status).toBe('lost')
    expect(Number(settled.payout)).toBe(0)
    expect(await balance()).toBe(9_970)
  })

  it('venda que fecha na alta é loss; na baixa é win', async () => {
    advance(1000)
    price('ETHUSDT', '3000')
    const { body: loser } = await openTrade('ETHUSDT', 'sell')
    priceAtExpiry(loser, '3010')
    expect((await expire(loser)).status).toBe('lost')
    expect(await balance()).toBe(9_870)

    advance(1000)
    const { body: winner } = await openTrade('ETHUSDT', 'sell')
    priceAtExpiry(winner, '2990')
    expect((await expire(winner)).status).toBe('won')
    expect(await balance()).toBe(9_940)
  })

  it('empate devolve o valor', async () => {
    advance(1000)
    price('SOLUSDT', '100')
    const { body: trade } = await openTrade('SOLUSDT', 'buy')
    priceAtExpiry(trade, '100')
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

  it(`limita a ${MAX_OPEN_TRADES} operações abertas por usuário`, async () => {
    const other = await signUp('cheio@example.com')
    advance(1000)
    price('BTCUSDT', '50000')
    for (let i = 0; i < MAX_OPEN_TRADES; i++) {
      expect((await openTrade('BTCUSDT', 'buy', '1', other)).status).toBe(201)
    }
    const { status, body } = await openTrade('BTCUSDT', 'buy', '1', other)
    expect(status).toBe(422)
    expect(body).toMatchObject({ error: { code: 'TOO_MANY_OPEN_TRADES' } })
  })

  it(`limita a ${TRADE_RATE_LIMIT} aberturas por minuto por usuário`, async () => {
    const spammer = await signUp('rajada@example.com')
    const statuses: number[] = []
    for (let i = 0; i <= TRADE_RATE_LIMIT; i++) {
      statuses.push((await openTrade('BTCUSDT', 'buy', '1', spammer)).status)
    }
    expect(statuses.slice(0, TRADE_RATE_LIMIT)).not.toContain(429)
    expect(statuses.at(-1)).toBe(429)
    // O limite é por usuário: quem não fez a rajada continua operando.
    expect((await openTrade('BTCUSDT', 'buy', '1')).status).toBe(201)
  })

  it('limita tentativas de login por IP sem bloquear a checagem de sessão', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: ORIGIN },
        payload: { email: 'trader@example.com', password: 'senha-errada-123' },
      })
      statuses.push(response.statusCode)
    }
    expect(statuses).toContain(401)
    expect(statuses.at(-1)).toBe(429)

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie, origin: ORIGIN },
    })
    expect(session.statusCode).toBe(200)
  })

  it('manda headers de segurança', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'")
  })
})
