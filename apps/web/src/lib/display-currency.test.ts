import { convertCurrency, type FxRatesDto } from '@b-hook/contracts'
import { describe, expect, it } from 'vitest'

const rates: FxRatesDto = { perUsd: { USD: 1, EUR: 0.9, GBP: 0.8, BRL: 5 }, updatedAt: 0 }

describe('convertCurrency', () => {
  it('converte passando pelo dólar', () => {
    expect(convertCurrency(50, 'BRL', 'USD', rates)).toBeCloseTo(10)
    expect(convertCurrency(50, 'BRL', 'EUR', rates)).toBeCloseTo(9)
    expect(convertCurrency(100, 'USD', 'GBP', rates)).toBeCloseTo(80)
  })

  it('trata USDT como dólar', () => {
    expect(convertCurrency(100, 'USDT', 'BRL', rates)).toBeCloseTo(500)
  })
})
