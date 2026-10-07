import type { OrderDto, PositionDto, WalletDto } from '@b-hook/contracts'
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
import { OrderService } from './trading/order-service.ts'

const ORIGIN = 'http://localhost:5173'

/** Provedor que não sai para a rede: os preços entram por hub.publish no próprio teste. */
const silentProvider: MarketDataProvider = {
  name: 'test',
  start: () => {},
  candles: async () => [],
  stop: () => {},
}

let app: FastifyInstance
let hub: MarketDataHub
let database: DatabaseHandle
let cookie: string

const price = (symbol: string, value: string) =>
  hub.publish({ symbol, price: value, time: Date.now() })

async function call<T>(method: 'GET' | 'POST', url: string, body?: object) {
  const response = await app.inject({
    method,
    url,
    headers: { cookie, origin: ORIGIN },
    ...(body ? { payload: body } : {}),
  })
  return { status: response.statusCode, body: response.json() as T }
}

async function portfolio() {
  const { body } = await call<{ wallets: WalletDto[]; positions: PositionDto[] }>(
    'GET',
    '/api/portfolio',
  )
  const wallet = (currency: string) => body.wallets.find((w) => w.currency === currency)
  const position = (symbol: string) => body.positions.find((p) => p.symbol === symbol)
  return { wallet, position }
}

async function waitForStatus(orderId: string, status: OrderDto['status']) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { body } = await call<OrderDto[]>('GET', '/api/orders')
    if (body.find((order) => order.id === orderId)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`ordem ${orderId} não chegou em ${status}`)
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
  const orderService = new OrderService(database.db, hub, console)
  await orderService.start()
  app = await buildApp({ auth, hub, orderService })

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

describe('API de trading', () => {
  it('bloqueia rotas privadas sem sessão', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/portfolio' })
    expect(response.statusCode).toBe(401)
  })

  it('abre a conta com saldo inicial em cada moeda', async () => {
    const { wallet } = await portfolio()
    expect(Number(wallet('USDT')?.balance)).toBe(10_000)
    expect(Number(wallet('USD')?.balance)).toBe(10_000)
    expect(Number(wallet('BRL')?.balance)).toBe(50_000)
  })

  it('recusa ordem a mercado sem cotação', async () => {
    const { status } = await call('POST', '/api/orders', {
      symbol: 'ETHUSDT',
      side: 'buy',
      type: 'market',
      quantity: '1',
    })
    expect(status).toBe(409)
  })

  it('executa compra a mercado no último preço, cobrando taxa', async () => {
    price('BTCUSDT', '50000')
    const { status, body } = await call<OrderDto>('POST', '/api/orders', {
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      quantity: '0.1',
    })
    expect(status).toBe(201)
    expect(body.status).toBe('filled')

    const { wallet, position } = await portfolio()
    // 0.1 x 50000 = 5000 + 0,1% de taxa = 5005
    expect(Number(wallet('USDT')?.balance)).toBe(4995)
    expect(Number(position('BTCUSDT')?.quantity)).toBe(0.1)
    expect(Number(position('BTCUSDT')?.averagePrice)).toBe(50000)
  })

  it('executa venda limitada quando o preço chega no alvo', async () => {
    const { body: order } = await call<OrderDto>('POST', '/api/orders', {
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'limit',
      quantity: '0.1',
      limitPrice: '51000',
    })
    expect(order.status).toBe('open')
    expect(Number((await portfolio()).position('BTCUSDT')?.lockedQuantity)).toBe(0.1)

    price('BTCUSDT', '50500')
    price('BTCUSDT', '51200')
    await waitForStatus(order.id, 'filled')

    const { wallet, position } = await portfolio()
    // Executa no preço do tick (51200): 5120 - 5,12 de taxa
    expect(Number(wallet('USDT')?.balance)).toBe(4995 + 5120 - 5.12)
    expect(Number(position('BTCUSDT')?.quantity)).toBe(0)
    // (51200 - 50000) x 0.1 - 5 (taxa compra) - 5,12 (taxa venda)
    expect(Number(position('BTCUSDT')?.realizedPnl)).toBeCloseTo(109.88, 8)
  })

  it('reserva caixa na compra limitada e devolve no cancelamento', async () => {
    price('PETR4', '38.50')
    const { body: order } = await call<OrderDto>('POST', '/api/orders', {
      symbol: 'PETR4',
      side: 'buy',
      type: 'limit',
      quantity: '100',
      limitPrice: '35',
    })
    expect(order.status).toBe('open')
    const reserved = (await portfolio()).wallet('BRL')
    expect(Number(reserved?.locked)).toBeCloseTo(3500 * 1.0003, 8)

    const { status } = await call<OrderDto>('POST', `/api/orders/${order.id}/cancel`)
    expect(status).toBe(200)
    const released = (await portfolio()).wallet('BRL')
    expect(Number(released?.balance)).toBe(50_000)
    expect(Number(released?.locked)).toBe(0)
  })

  it('valida saldo, posição e precisão da quantidade', async () => {
    price('AAPL', '200')
    const tooBig = await call('POST', '/api/orders', {
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      quantity: '1000',
    })
    expect(tooBig.status).toBe(422)

    const fractional = await call('POST', '/api/orders', {
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      quantity: '1.5',
    })
    expect(fractional.status).toBe(422)

    const naked = await call('POST', '/api/orders', {
      symbol: 'AAPL',
      side: 'sell',
      type: 'market',
      quantity: '1',
    })
    expect(naked.status).toBe(422)
  })
})
