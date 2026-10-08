import { describe, expect, it } from 'vitest'
import { formatCountdown, formatPrice, formatQuantity, priceDecimals } from './format.ts'

// Intl usa espaço não separável entre símbolo e valor; normalizamos para comparar.
const plain = (text: string) => text.replace(/\s/g, ' ')

describe('format', () => {
  it('ajusta as casas decimais à grandeza do preço', () => {
    expect(priceDecimals(83000)).toBe(2)
    expect(priceDecimals(0.52)).toBe(4)
    expect(priceDecimals(0.00001234)).toBe(8)
  })

  it('formata cada moeda no padrão do seu mercado', () => {
    expect(plain(formatPrice('54.46', 'BRL'))).toBe('R$ 54,46')
    expect(plain(formatPrice('336.9', 'USD'))).toBe('$336.90')
    expect(plain(formatPrice('83350.68', 'USDT'))).toBe('83.350,68 USDT')
  })

  it('remove zeros à direita que o numeric do banco devolve', () => {
    expect(formatQuantity('0.1000000000', 5)).toBe('0,1')
  })

  it('conta o tempo restante do candle arredondando o segundo para cima', () => {
    expect(formatCountdown(42_300)).toBe('0:43')
    expect(formatCountdown(14 * 60_000 + 5_000)).toBe('14:05')
    expect(formatCountdown(3 * 3_600_000 + 12 * 60_000 + 9_000)).toBe('3:12:09')
    expect(formatCountdown(0)).toBe('0:00')
  })
})
