import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { AppError } from '../shared/errors.ts'
import {
  applyBuy,
  applySell,
  assertQuantityPrecision,
  crosses,
  EMPTY_POSITION,
  FEE_RATES,
  quote,
} from './ledger.ts'

const d = (value: string | number) => new Decimal(value)

describe('quote', () => {
  it('calcula notional e taxa sem erro de float', () => {
    const { notional, fee } = quote(d('0.1'), d('0.2'), FEE_RATES.CRYPTO)
    expect(notional.toString()).toBe('0.02')
    expect(fee.toString()).toBe('0.00002')
  })
})

describe('applyBuy', () => {
  it('recalcula o preço médio ponderado entre compras', () => {
    const first = applyBuy(EMPTY_POSITION, d(10), d(20), d(0))
    const second = applyBuy(first, d(30), d(40), d(0))
    expect(second.quantity.toString()).toBe('40')
    expect(second.averagePrice.toString()).toBe('35')
  })

  it('desconta a taxa do resultado realizado', () => {
    const position = applyBuy(EMPTY_POSITION, d(1), d(100), d('0.1'))
    expect(position.realizedPnl.toString()).toBe('-0.1')
  })
})

describe('applySell', () => {
  const bought = applyBuy(EMPTY_POSITION, d(10), d(50), d(0))

  it('realiza o lucro sobre o preço médio, líquido de taxa', () => {
    const position = applySell(bought, d(4), d(60), d('0.5'))
    expect(position.quantity.toString()).toBe('6')
    expect(position.averagePrice.toString()).toBe('50')
    expect(position.realizedPnl.toString()).toBe('39.5')
  })

  it('zera o preço médio quando a posição fecha', () => {
    const position = applySell(bought, d(10), d(40), d(0))
    expect(position.quantity.isZero()).toBe(true)
    expect(position.averagePrice.isZero()).toBe(true)
    expect(position.realizedPnl.toString()).toBe('-100')
  })

  it('recusa vender mais do que tem', () => {
    expect(() => applySell(bought, d(11), d(50), d(0))).toThrow(AppError)
  })
})

describe('assertQuantityPrecision', () => {
  it('exige quantidade inteira em ações', () => {
    expect(() => assertQuantityPrecision(d('1.5'), 0)).toThrow(/inteira/)
    expect(() => assertQuantityPrecision(d('100'), 0)).not.toThrow()
  })

  it('limita as casas decimais em cripto', () => {
    expect(() => assertQuantityPrecision(d('0.000001'), 5)).toThrow(/5 casas/)
    expect(() => assertQuantityPrecision(d('0.00001'), 5)).not.toThrow()
  })
})

describe('crosses', () => {
  it('compra limitada executa quando o preço cai até o limite', () => {
    expect(crosses('buy', d(100), d(101))).toBe(false)
    expect(crosses('buy', d(100), d(100))).toBe(true)
    expect(crosses('buy', d(100), d(99))).toBe(true)
  })

  it('venda limitada executa quando o preço sobe até o limite', () => {
    expect(crosses('sell', d(100), d(99))).toBe(false)
    expect(crosses('sell', d(100), d(100))).toBe(true)
  })
})
