import type { CandleDto } from '@notbroker/contracts'
import { describe, expect, it, vi } from 'vitest'
import { findInstrument, type Instrument } from './catalog.ts'
import { MarketDataHub } from './hub.ts'
import { type MarketDataProvider, UpstreamError } from './provider.ts'

const candle: CandleDto = { time: 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }
const btc = findInstrument('BTCUSDT') as Instrument

function hubWith(candles: MarketDataProvider['candles']) {
  const provider: MarketDataProvider = {
    name: 'teste',
    realtime: true,
    start: () => {},
    candles,
    stop: () => {},
  }
  return new MarketDataHub({ CRYPTO: provider, US: provider, B3: provider })
}

describe('histórico de velas', () => {
  it('com o provedor fora, devolve o último histórico bom em vez de erro', async () => {
    vi.useFakeTimers()
    const candles = vi
      .fn()
      .mockResolvedValueOnce([candle])
      .mockRejectedValueOnce(new UpstreamError('teste', 'timeout'))
    const hub = hubWith(candles)
    await expect(hub.candles(btc, '1m')).resolves.toEqual([candle])
    vi.advanceTimersByTime(60_000)
    await expect(hub.candles(btc, '1m')).resolves.toEqual([candle])
    expect(candles).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('sem histórico guardado, resposta fora do formato vira provedor indisponível', async () => {
    const hub = hubWith(() => Promise.reject(new SyntaxError('Unexpected token <')))
    await expect(hub.candles(btc, '5m')).rejects.toBeInstanceOf(UpstreamError)
  })

  it('falha não fica em cache: a próxima chamada tenta o provedor de novo', async () => {
    const candles = vi
      .fn()
      .mockRejectedValueOnce(new UpstreamError('teste', 'timeout'))
      .mockResolvedValueOnce([candle])
    const hub = hubWith(candles)
    await expect(hub.candles(btc, '15m')).rejects.toThrow()
    await expect(hub.candles(btc, '15m')).resolves.toEqual([candle])
  })
})
