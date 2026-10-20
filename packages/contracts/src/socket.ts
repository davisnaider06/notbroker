import { z } from 'zod'
import type { DepositDto, WithdrawalDto } from './payments.ts'
import type { TradeDto } from './trades.ts'

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), symbols: z.array(z.string()).max(50) }),
  z.object({ type: z.literal('unsubscribe'), symbols: z.array(z.string()).max(50) }),
  /** Acerto de relógio: `sentAt` é o Date.now() do navegador, devolvido no pong. */
  z.object({ type: z.literal('ping'), sentAt: z.number() }),
])

export type ClientMessage = z.infer<typeof clientMessageSchema>

export type ServerMessage =
  | {
      type: 'tick'
      symbol: string
      /** Último preço da janela (fechamento). */
      price: string
      time: number
      /**
       * Abertura, máxima e mínima de todos os negócios da janela de envio (~250 ms). Sem isso, um pico
       * que vai e volta dentro da janela some do pavio da vela ao vivo.
       */
      open: string
      high: string
      low: string
    }
  | { type: 'trade'; trade: TradeDto }
  /** Mudança de status de depósito ou saque do próprio usuário (webhook do gateway). */
  | { type: 'deposit'; deposit: DepositDto }
  | { type: 'withdrawal'; withdrawal: WithdrawalDto }
  /** Relógio do servidor, que decide expiração e janela de entrada. */
  | { type: 'pong'; sentAt: number; serverTime: number }
  | { type: 'error'; message: string }
