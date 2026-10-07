import { z } from 'zod'
import type { Currency } from './markets.ts'

export const ORDER_SIDES = ['buy', 'sell'] as const
export type OrderSide = (typeof ORDER_SIDES)[number]

export const ORDER_TYPES = ['market', 'limit'] as const
export type OrderType = (typeof ORDER_TYPES)[number]

export const ORDER_STATUSES = ['open', 'filled', 'canceled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** Valores monetários trafegam como string decimal para nunca passar por float. */
const positiveDecimal = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'deve ser um número decimal positivo')
  .refine((value) => Number(value) > 0, 'deve ser maior que zero')

export const placeOrderSchema = z
  .object({
    symbol: z.string().trim().toUpperCase(),
    side: z.enum(ORDER_SIDES),
    type: z.enum(ORDER_TYPES),
    quantity: positiveDecimal,
    limitPrice: positiveDecimal.optional(),
  })
  .refine((order) => order.type === 'market' || order.limitPrice !== undefined, {
    message: 'ordem limitada exige limitPrice',
    path: ['limitPrice'],
  })

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>

export interface OrderDto {
  id: string
  symbol: string
  side: OrderSide
  type: OrderType
  status: OrderStatus
  quantity: string
  limitPrice: string | null
  fillPrice: string | null
  fee: string | null
  currency: Currency
  createdAt: string
  filledAt: string | null
}

export interface PositionDto {
  symbol: string
  currency: Currency
  quantity: string
  /** Quantidade presa em ordens de venda limitadas abertas. */
  lockedQuantity: string
  averagePrice: string
  realizedPnl: string
}

export interface WalletDto {
  currency: Currency
  balance: string
  /** Saldo preso em ordens de compra limitadas abertas. */
  locked: string
}
