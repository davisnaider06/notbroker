import { CURRENCIES, MARKETS, TRADE_DIRECTIONS, TRADE_STATUSES } from '@b-hook/contracts'
import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.ts'

export const marketEnum = pgEnum('market', MARKETS)
export const currencyEnum = pgEnum('currency', CURRENCIES)
export const tradeDirectionEnum = pgEnum('trade_direction', TRADE_DIRECTIONS)
export const tradeStatusEnum = pgEnum('trade_status', TRADE_STATUSES)

/** numeric(30,10) cobre de satoshi a ações de 5 dígitos sem perder precisão. Drizzle devolve string. */
const decimal = (name: string) => numeric(name, { precision: 30, scale: 10 })

const userRef = () =>
  text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' })

export const instruments = pgTable('instruments', {
  symbol: text('symbol').primaryKey(),
  name: text('name').notNull(),
  market: marketEnum('market').notNull(),
  currency: currencyEnum('currency').notNull(),
  quantityDecimals: integer('quantity_decimals').notNull(),
})

/**
 * Saldo da conta. Na casa de binárias só existe a carteira em BRL; `locked` sobrou do modelo
 * anterior e fica sempre zero (o valor de uma operação aberta já saiu do saldo).
 */
export const wallets = pgTable(
  'wallets',
  {
    userId: userRef(),
    currency: currencyEnum('currency').notNull(),
    balance: decimal('balance').notNull(),
    locked: decimal('locked').notNull().default('0'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.currency] })],
)

/**
 * Operação de opção binária. O valor apostado sai do saldo na abertura; no fechamento volta
 * valor + payout (win), só o valor (empate/estorno) ou nada (loss).
 */
export const binaryTrades = pgTable(
  'binary_trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userRef(),
    symbol: text('symbol')
      .notNull()
      .references(() => instruments.symbol),
    direction: tradeDirectionEnum('direction').notNull(),
    status: tradeStatusEnum('status').notNull(),
    stake: decimal('stake').notNull(),
    /** Gravado por operação: mudar o payout da casa não altera o que já foi aberto. */
    payoutRate: decimal('payout_rate').notNull(),
    entryPrice: decimal('entry_price').notNull(),
    exitPrice: decimal('exit_price'),
    payout: decimal('payout'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    index('binary_trades_user_opened_idx').on(table.userId, table.openedAt),
    index('binary_trades_status_idx').on(table.status),
  ],
)
