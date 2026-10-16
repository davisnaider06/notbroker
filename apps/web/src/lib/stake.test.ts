import { describe, expect, it } from 'vitest'
import { stakeForPercent } from './stake.ts'

describe('stakeForPercent', () => {
  it('calcula a fração do saldo, para baixo no centavo', () => {
    expect(stakeForPercent('10000', 2)).toBe('200')
    expect(stakeForPercent('100', 5)).toBe('5')
    expect(stakeForPercent('107.30', 2)).toBe('2.14')
  })

  it('nunca fica abaixo do mínimo da casa, nem acima do que o saldo cobre', () => {
    expect(stakeForPercent('20', 1)).toBe('1')
    expect(stakeForPercent('0.80', 10)).toBeNull()
  })
})
