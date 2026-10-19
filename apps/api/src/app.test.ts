import {
  type AccountDto,
  type Expiration,
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
import { RESET_RATE_LIMIT, TRADE_RATE_LIMIT } from './http/routes/trading.ts'
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

/**
 * Relógio do teste: 1 s depois da próxima virada de minuto, dentro da janela de entrada de 5 s da
 * vela de 1m. Fica à frente do relógio real porque o início da banca (cadastro) é gravado com a
 * hora real.
 */
let clock = Math.ceil(Date.now() / 60_000) * 60_000 + 1_000
let app: FastifyInstance
let hub: MarketDataHub
let binaryService: BinaryService
let database: DatabaseHandle
let cookie: string
let windowUser: string

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

/** Prazo curto de espera pelo negócio de entrada: o teste não fica parado 3 s a cada recusa. */
const ENTRY_WAIT_MS = 300

/**
 * Abre operação com o feed vivo: enquanto a ordem está em andamento, o último negócio do ativo é
 * reenviado, como faria um mercado negociando. A entrada é o primeiro negócio depois da ordem.
 */
async function openTrade(
  symbol: string,
  direction: 'buy' | 'sell',
  stake = '100',
  as = cookie,
  expiration: Expiration = '1m',
) {
  const feed = setInterval(() => {
    const tick = hub.lastTick(symbol)
    if (tick) hub.publish({ ...tick })
  }, 5)
  try {
    return await call<TradeDto>('POST', '/api/trades', { symbol, direction, stake, expiration }, as)
  } finally {
    clearInterval(feed)
  }
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

/**
 * Leva o relógio até a expiração e liquida. O mercado segue negociando: o último preço se repete
 * logo depois da virada, e é esse negócio que fecha a vela.
 */
async function expire(trade: TradeDto, as = cookie): Promise<TradeDto> {
  clock = Date.parse(trade.expiresAt) + 1
  const last = hub.lastTick(trade.symbol)
  if (last) price(trade.symbol, last.price)
  await binaryService.settleDue()
  const { body } = await call<TradeDto[]>('GET', '/api/trades', undefined, as)
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
    entryWaitMs: { CRYPTO: ENTRY_WAIT_MS, US: ENTRY_WAIT_MS, B3: ENTRY_WAIT_MS },
  })
  await binaryService.start()
  /** Câmbio fixo: o teste não sai para a rede. */
  const fx = {
    rates: async () => ({ perUsd: { USD: 1, EUR: 0.9, GBP: 0.8, BRL: 5 }, updatedAt: 0 }),
  }
  app = await buildApp({ auth, hub, fx, binaryService })

  cookie = await signUp('trader@example.com')
  // Antes do teste de força bruta, que esgota as tentativas de login/cadastro do IP.
  windowUser = await signUp('janela@example.com')
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
    expect(body.stats).toMatchObject({ won: 0, lost: 0, draw: 0, refunded: 0 })
  })

  it('recusa operação sem cotação', async () => {
    const { status, body } = await openTrade('ETHUSDT', 'buy')
    expect(status).toBe(409)
    expect(body).toMatchObject({ error: { code: 'NO_FRESH_PRICE' } })
  })

  it('feed travado: com último preço conhecido mas sem negócio novo, recusa', async () => {
    price('SOLUSDT', '100')
    // Sem o helper: nenhum negócio chega enquanto a ordem espera.
    const { status, body } = await call<TradeDto>('POST', '/api/trades', {
      symbol: 'SOLUSDT',
      direction: 'buy',
      stake: '100',
      expiration: '1m',
    })
    expect(status).toBe(409)
    expect(body).toMatchObject({ error: { code: 'NO_FRESH_PRICE' } })
    expect(await balance()).toBe(10_000)
  })

  it('entrada é o primeiro negócio depois da ordem, não o último antes dela', async () => {
    // Quem vê o mercado em outra fonte sabe que o preço já foi de 100 para 105; a casa ainda não.
    price('SOLUSDT', '100')
    const pending = call<TradeDto>('POST', '/api/trades', {
      symbol: 'SOLUSDT',
      direction: 'buy',
      stake: '100',
      expiration: '1m',
    })
    const feed = setInterval(() => price('SOLUSDT', '105'), 5)
    const { status, body: trade } = await pending
    clearInterval(feed)
    expect(status).toBe(201)
    expect(Number(trade.entryPrice)).toBe(105)
    // Fecha empatado para não mexer no saldo que os testes seguintes conferem.
    priceAtExpiry(trade, '105')
    expect((await expire(trade)).status).toBe('draw')
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

  it('soma o desempenho das operações fechadas', async () => {
    const { body } = await call<AccountDto>('GET', '/api/account')
    expect(Number(body.startingBalance)).toBe(10_000)
    // Inclui o empate do teste de preço de entrada.
    expect(body.stats).toMatchObject({ won: 3, lost: 2, draw: 2, refunded: 1 })
    expect(Number(body.stats.staked)).toBe(800)
    expect(Number(body.stats.netProfit)).toBe(10)
    expect(Number(body.balance)).toBe(10_010)
  })

  it('começa banca nova com o saldo escolhido e zera o desempenho', async () => {
    const as = await signUp('banca@example.com')
    const reset = (balance: string) =>
      call<AccountDto>('POST', '/api/account/reset', { balance }, as)

    const { status, body } = await reset('100')
    expect(status).toBe(200)
    expect(Number(body.balance)).toBe(100)
    expect(Number(body.startingBalance)).toBe(100)

    advance(1000)
    price('BTCUSDT', '50000')
    const { body: trade } = await openTrade('BTCUSDT', 'buy', '10', as)
    // Com operação aberta, o resultado dela ainda não saiu: não dá para recomeçar.
    expect(await reset('100')).toMatchObject({
      status: 409,
      body: { error: { code: 'TRADES_OPEN' } },
    })

    priceAtExpiry(trade, '50100')
    await expire(trade, as)
    const { body: after } = await call<AccountDto>('GET', '/api/account', undefined, as)
    expect(Number(after.balance)).toBe(107)
    expect(after.stats).toMatchObject({ won: 1, lost: 0 })
    expect(Number(after.stats.netProfit)).toBe(7)

    expect((await reset('5')).status).toBe(400)
    expect((await reset('2000000')).status).toBe(400)

    advance(1000)
    const { body: fresh } = await reset('50')
    expect(Number(fresh.balance)).toBe(50)
    expect(fresh.stats).toMatchObject({ won: 0, lost: 0, draw: 0, refunded: 0 })
    expect(Number(fresh.stats.netProfit)).toBe(0)
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

  it(`limita a ${RESET_RATE_LIMIT} bancas novas por minuto por usuário`, async () => {
    const as = await signUp('resetador@example.com')
    const statuses: number[] = []
    for (let i = 0; i <= RESET_RATE_LIMIT; i++) {
      statuses.push((await call('POST', '/api/account/reset', { balance: '100' }, as)).status)
    }
    expect(statuses.slice(0, RESET_RATE_LIMIT)).not.toContain(429)
    expect(statuses.at(-1)).toBe(429)
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

describe('janela de entrada e liquidação', () => {
  /** Leva o relógio para `offsetMs` depois da abertura da próxima vela do tempo dado. */
  const nextCandle = (bucketMs: number, offsetMs: number) => {
    clock = Math.ceil(clock / bucketMs) * bucketMs + offsetMs
  }

  it('recusa fora dos 5 s da vela de 1m, com o tempo até a próxima janela', async () => {
    nextCandle(60_000, 5_000)
    price('BTCUSDT', '50000')
    const { status, body } = await openTrade('BTCUSDT', 'buy', '100', windowUser)
    expect(status).toBe(409)
    expect(body).toMatchObject({
      error: { code: 'ENTRY_WINDOW_CLOSED', message: expect.stringContaining('55 s') },
    })
    const { body: account } = await call<AccountDto>('GET', '/api/account', undefined, windowUser)
    expect(Number(account.balance)).toBe(10_000)
  })

  it('vela de 5m aceita entrada até 25 s depois da abertura', async () => {
    nextCandle(300_000, 20_000)
    price('ETHUSDT', '3000')
    expect((await openTrade('ETHUSDT', 'buy', '100', windowUser, '5m')).status).toBe(201)
    nextCandle(300_000, 25_000)
    price('ETHUSDT', '3000')
    expect((await openTrade('ETHUSDT', 'buy', '100', windowUser, '5m')).status).toBe(409)
  })

  it('só liquida depois do negócio que fecha a vela', async () => {
    nextCandle(60_000, 1_000)
    price('SOLUSDT', '100')
    const { body: trade } = await openTrade('SOLUSDT', 'buy', '100', windowUser)
    const expiresAt = Date.parse(trade.expiresAt)
    price('SOLUSDT', '110', expiresAt - 500)
    clock = expiresAt + 1
    await binaryService.settleDue()
    // Ainda pode chegar negócio de antes da virada (latência da bolsa): a liquidação espera.
    price('SOLUSDT', '95', expiresAt - 100)
    await binaryService.settleDue()
    const { body: open } = await call<TradeDto[]>('GET', '/api/trades', undefined, windowUser)
    expect(open.find((item) => item.id === trade.id)?.status).toBe('open')

    price('SOLUSDT', '120', expiresAt + 50)
    const settled = await expire(trade, windowUser)
    expect(settled.status).toBe('lost')
    expect(Number(settled.exitPrice)).toBe(95)
  })

  it('sem negócio depois da expiração, usa o último conhecido passado o prazo', async () => {
    nextCandle(60_000, 1_000)
    price('XRPUSDT', '1.00')
    const { body: trade } = await openTrade('XRPUSDT', 'buy', '100', windowUser)
    const expiresAt = Date.parse(trade.expiresAt)
    price('XRPUSDT', '1.05', expiresAt - 500)
    clock = expiresAt + ENTRY_WAIT_MS - 1
    await binaryService.settleDue()
    const { body: waiting } = await call<TradeDto[]>('GET', '/api/trades', undefined, windowUser)
    expect(waiting.find((item) => item.id === trade.id)?.status).toBe('open')

    clock = expiresAt + ENTRY_WAIT_MS
    await binaryService.settleDue()
    const { body } = await call<TradeDto[]>('GET', '/api/trades', undefined, windowUser)
    expect(body.find((item) => item.id === trade.id)).toMatchObject({ status: 'won' })
  })

  it('operações na mesma vela são independentes: compra e venda podem ganhar as duas', async () => {
    nextCandle(60_000, 1_000)
    const { body: before } = await call<AccountDto>('GET', '/api/account', undefined, windowUser)
    price('BTCUSDT', '100')
    const { body: buy } = await openTrade('BTCUSDT', 'buy', '100', windowUser)
    advance(2_000)
    price('BTCUSDT', '110')
    const { body: sell } = await openTrade('BTCUSDT', 'sell', '100', windowUser)
    expect(sell.expiresAt).toBe(buy.expiresAt)

    // Fechou entre as duas entradas: acima da compra e abaixo da venda.
    priceAtExpiry(buy, '105')
    expect((await expire(buy, windowUser)).status).toBe('won')
    expect((await expire(sell, windowUser)).status).toBe('won')
    const { body: after } = await call<AccountDto>('GET', '/api/account', undefined, windowUser)
    expect(Number(after.balance) - Number(before.balance)).toBe(140)
  })
})
