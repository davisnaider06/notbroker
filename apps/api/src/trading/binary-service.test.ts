import { expiryFor } from '@b-hook/contracts'
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

  it('expira no fechamento da vela; com menos de 30 s, vai para a seguinte', () => {
    expect(expiryFor(at(13, 0, 10), '1m')).toBe(at(13, 1, 0))
    expect(expiryFor(at(13, 0, 30), '1m')).toBe(at(13, 1, 0))
    expect(expiryFor(at(13, 0, 31), '1m')).toBe(at(13, 2, 0))
    expect(expiryFor(at(13, 2, 0), '5m')).toBe(at(13, 5, 0))
    expect(expiryFor(at(13, 4, 45), '5m')).toBe(at(13, 10, 0))
  })
})
