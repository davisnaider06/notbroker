import { afterEach, describe, expect, it } from 'vitest'
import { recordPong, resetServerClock, serverNow } from './server-clock.ts'

afterEach(resetServerClock)

describe('relógio do servidor', () => {
  it('corrige o relógio do PC pela diferença medida no pong', () => {
    // PC 2 s atrasado: mandou às 1000, o servidor respondeu às 3050, chegou às 1100.
    recordPong(1000, 3050, 1100)
    const now = Date.now()
    expect(serverNow() - now).toBeGreaterThanOrEqual(1999)
    expect(serverNow() - now).toBeLessThanOrEqual(2001)
  })

  it('fica com a amostra de menor ida e volta', () => {
    recordPong(1000, 3050, 1100)
    // Ida e volta lenta e assimétrica: estimaria 1 s em vez de 2 s.
    recordPong(5000, 6500, 6000)
    const offset = serverNow() - Date.now()
    expect(Math.abs(offset - 2000)).toBeLessThanOrEqual(1)
  })
})
