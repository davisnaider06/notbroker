import { describe, expect, it } from 'vitest'
import { mergeTick, type TickWindow } from './socket-gateway.ts'

describe('janela de ticks do WebSocket', () => {
  it('guarda abertura, máxima e mínima mesmo quando o preço volta', () => {
    let window: TickWindow | undefined
    for (const [price, time] of [
      ['100', 1],
      ['105', 2],
      ['97', 3],
      ['101', 4],
    ] as const) {
      window = mergeTick(window, { symbol: 'BTCUSDT', price, time })
    }
    expect(window).toEqual({
      symbol: 'BTCUSDT',
      price: '101',
      time: 4,
      open: '100',
      high: '105',
      low: '97',
    })
  })
})
