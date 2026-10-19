import { entryWindow, expiryFor } from '@notbroker/contracts'
import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { outcome, payoutFor } from './binary-service.ts'

const at = (h: number, m: number, s: number) => Date.UTC(2026, 9, 8, h, m, s)

describe('regras da binária', () => {
  it('compra ganha na alta, venda ganha na baixa, igual empata', () => {
    expect(outcome('buy', { entryPrice: '100' }, '101')).toBe('won')
    expect(outcome('buy', { entryPrice: '100' }, '99')).toBe('lost')
    expect(outcome('sell', { entryPrice: '100' }, '101')).toBe('lost')
    expect(outcome('sell', { entryPrice: '100' }, '99')).toBe('won')
    expect(outcome('buy', { entryPrice: '100' }, '100.0000000000')).toBe('draw')
  })

  it('win paga valor + 70%, empate devolve, loss zera', () => {
    const rate = new Decimal('0.70')
    expect(payoutFor('won', new Decimal(100), rate).toNumber()).toBe(170)
    expect(payoutFor('won', new Decimal('33.33'), rate).toNumber()).toBe(56.66)
    expect(payoutFor('draw', new Decimal(100), rate).toNumber()).toBe(100)
    expect(payoutFor('refunded', new Decimal(100), rate).toNumber()).toBe(100)
    expect(payoutFor('lost', new Decimal(100), rate).toNumber()).toBe(0)
  })

  it('expira no fechamento da vela corrente', () => {
    expect(expiryFor(at(13, 0, 0), '1m')).toBe(at(13, 1, 0))
    expect(expiryFor(at(13, 0, 59), '1m')).toBe(at(13, 1, 0))
    expect(expiryFor(at(13, 2, 0), '5m')).toBe(at(13, 5, 0))
    expect(expiryFor(at(13, 30, 0), '1h')).toBe(at(14, 0, 0))
  })

  it('entrada só nos primeiros 5 s por minuto de vela, contados da abertura UTC', () => {
    expect(entryWindow(at(13, 0, 0), '1m').open).toBe(true)
    expect(entryWindow(Date.UTC(2026, 9, 8, 13, 0, 4, 999), '1m').open).toBe(true)
    expect(entryWindow(at(13, 0, 5), '1m')).toEqual({
      open: false,
      closesAt: at(13, 0, 5),
      nextOpensAt: at(13, 1, 0),
    })
    // 5m = 25 s, 15m = 75 s, 1h = 300 s, sempre desde a abertura da vela daquele tempo.
    expect(entryWindow(at(13, 5, 24), '5m').open).toBe(true)
    expect(entryWindow(at(13, 5, 25), '5m').open).toBe(false)
    expect(entryWindow(at(13, 16, 14), '15m').open).toBe(true)
    expect(entryWindow(at(13, 16, 15), '15m').open).toBe(false)
    expect(entryWindow(at(13, 4, 59), '1h').open).toBe(true)
    expect(entryWindow(at(13, 5, 0), '1h').open).toBe(false)
  })
})
