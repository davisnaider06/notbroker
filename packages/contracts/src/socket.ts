import { z } from 'zod'
import type { TradeDto } from './trades.ts'

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), symbols: z.array(z.string()).max(50) }),
  z.object({ type: z.literal('unsubscribe'), symbols: z.array(z.string()).max(50) }),
])

export type ClientMessage = z.infer<typeof clientMessageSchema>

export type ServerMessage =
  | { type: 'tick'; symbol: string; price: string; time: number }
  | { type: 'trade'; trade: TradeDto }
  | { type: 'error'; message: string }
