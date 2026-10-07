import { type Currency, MARKET_FEE_RATES, type Market } from '@b-hook/contracts'
import { Decimal } from 'decimal.js'
import { AppError } from '../shared/errors.ts'

/** Mesma escala do numeric(30,10) do banco. */
export const SCALE = 10

export const STARTING_BALANCES: Record<Currency, string> = {
  USDT: '10000',
  USD: '10000',
  BRL: '50000',
}

export const FEE_RATES: Record<Market, Decimal> = {
  CRYPTO: new Decimal(MARKET_FEE_RATES.CRYPTO),
  US: new Decimal(MARKET_FEE_RATES.US),
  B3: new Decimal(MARKET_FEE_RATES.B3),
}

export interface PositionState {
  quantity: Decimal
  lockedQuantity: Decimal
  averagePrice: Decimal
  /** Resultado realizado, já líquido de taxas. */
  realizedPnl: Decimal
}

export const EMPTY_POSITION: PositionState = {
  quantity: new Decimal(0),
  lockedQuantity: new Decimal(0),
  averagePrice: new Decimal(0),
  realizedPnl: new Decimal(0),
}

export function round(value: Decimal): Decimal {
  return value.toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN)
}

export function quote(quantity: Decimal, price: Decimal, feeRate: Decimal) {
  const notional = round(quantity.times(price))
  const fee = round(notional.times(feeRate))
  return { notional, fee }
}

export function assertQuantityPrecision(quantity: Decimal, decimals: number): void {
  if (quantity.decimalPlaces() > decimals) {
    throw new AppError(
      422,
      'INVALID_QUANTITY',
      decimals === 0
        ? 'Esse ativo só aceita quantidade inteira'
        : `Esse ativo aceita no máximo ${decimals} casas decimais na quantidade`,
    )
  }
}

/** Compra soma à posição e recalcula o preço médio ponderado. A taxa entra no resultado realizado. */
export function applyBuy(
  position: PositionState,
  quantity: Decimal,
  price: Decimal,
  fee: Decimal,
): PositionState {
  const newQuantity = position.quantity.plus(quantity)
  const totalCost = position.quantity.times(position.averagePrice).plus(quantity.times(price))
  return {
    quantity: newQuantity,
    lockedQuantity: position.lockedQuantity,
    averagePrice: round(totalCost.dividedBy(newQuantity)),
    realizedPnl: round(position.realizedPnl.minus(fee)),
  }
}

/** Venda realiza (preço - médio) x quantidade. Sem venda a descoberto no MVP. */
export function applySell(
  position: PositionState,
  quantity: Decimal,
  price: Decimal,
  fee: Decimal,
): PositionState {
  if (quantity.greaterThan(position.quantity)) {
    throw new AppError(422, 'INSUFFICIENT_POSITION', 'Quantidade maior que a posição')
  }
  const newQuantity = position.quantity.minus(quantity)
  const gain = price.minus(position.averagePrice).times(quantity)
  return {
    quantity: newQuantity,
    lockedQuantity: position.lockedQuantity,
    averagePrice: newQuantity.isZero() ? new Decimal(0) : position.averagePrice,
    realizedPnl: round(position.realizedPnl.plus(gain).minus(fee)),
  }
}

/** Ordem limitada cruza quando o mercado chega no preço: compra a ≤ limite, venda a ≥ limite. */
export function crosses(side: 'buy' | 'sell', limitPrice: Decimal, marketPrice: Decimal): boolean {
  return side === 'buy'
    ? marketPrice.lessThanOrEqualTo(limitPrice)
    : marketPrice.greaterThanOrEqualTo(limitPrice)
}
