import { describe, expect, it } from 'vitest'
import { parseAlpacaBars, parseAlpacaFrame } from './alpaca.ts'
import { parseBinanceKlines, parseBinanceMessage } from './binance.ts'
import { parseYahooChart } from './yahoo.ts'

describe('binance', () => {
  it('extrai o tick de um aggTrade do stream combinado', () => {
    const raw = JSON.stringify({
      stream: 'btcusdt@aggTrade',
      data: { e: 'aggTrade', s: 'BTCUSDT', p: '83226.98', q: '0.01', T: 1791396060000 },
    })
    expect(parseBinanceMessage(raw)).toEqual({
      symbol: 'BTCUSDT',
      price: '83226.98',
      time: 1791396060000,
    })
  })

  it('ignora mensagens que não são negócio', () => {
    expect(parseBinanceMessage(JSON.stringify({ result: null, id: 1 }))).toBeUndefined()
  })

  it('converte klines para candles em segundos', () => {
    const payload = [
      [1791396060000, '1', '3', '0.5', '2', '10', 1791396119999, '0', 5, '0', '0', '0'],
    ]
    expect(parseBinanceKlines(payload)).toEqual([
      { time: 1791396060, open: 1, high: 3, low: 0.5, close: 2, volume: 10 },
    ])
  })
})

describe('yahoo', () => {
  it('lê o último preço e descarta minutos sem negócio', () => {
    const payload = {
      chart: {
        result: [
          {
            meta: { regularMarketPrice: 54.38, regularMarketTime: 1791395223 },
            timestamp: [100, 160],
            indicators: {
              quote: [
                {
                  open: [54, null],
                  high: [55, null],
                  low: [53, null],
                  close: [54.5, null],
                  volume: [1000, null],
                },
              ],
            },
          },
        ],
      },
    }
    const parsed = parseYahooChart(payload)
    expect(parsed.price).toBe(54.38)
    expect(parsed.time).toBe(1791395223000)
    expect(parsed.candles).toEqual([
      { time: 100, open: 54, high: 55, low: 53, close: 54.5, volume: 1000 },
    ])
  })
})

describe('alpaca', () => {
  it('interpreta o handshake e os negócios de um frame', () => {
    const frame = JSON.stringify([
      { T: 'success', msg: 'authenticated' },
      { T: 't', S: 'AAPL', p: 201.5, s: 10, t: '2026-10-07T14:30:00.123Z', i: 1, x: 'V', z: 'C' },
      { T: 'q', S: 'AAPL', bp: 201.4, ap: 201.6 },
      { T: 'error', code: 406, msg: 'connection limit exceeded' },
    ])
    expect(parseAlpacaFrame(frame)).toEqual([
      { kind: 'authenticated' },
      {
        kind: 'tick',
        tick: { symbol: 'AAPL', price: '201.5', time: Date.parse('2026-10-07T14:30:00.123Z') },
      },
      { kind: 'error', message: '406 connection limit exceeded' },
    ])
  })

  it('devolve barras em ordem crescente', () => {
    const payload = {
      bars: [
        { t: '2026-10-07T14:31:00Z', o: 2, h: 2, l: 2, c: 2, v: 1 },
        { t: '2026-10-07T14:30:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 },
      ],
      next_page_token: null,
    }
    expect(parseAlpacaBars(payload).map((candle) => candle.close)).toEqual([1, 2])
  })
})
