import { CURRENCIES, MARKETS, ORDER_SIDES, ORDER_STATUSES, ORDER_TYPES } from '@b-hook/contracts'
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
export const orderSideEnum = pgEnum('order_side', ORDER_SIDES)
export const orderTypeEnum = pgEnum('order_type', ORDER_TYPES)
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES)

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

/** `balance` é o saldo livre; `locked` é o que está reservado por ordens de compra limitadas. */
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

export const positions = pgTable(
  'positions',
  {
    userId: userRef(),
    symbol: text('symbol')
      .notNull()
      .references(() => instruments.symbol),
    quantity: decimal('quantity').notNull(),
    lockedQuantity: decimal('locked_quantity').notNull().default('0'),
    averagePrice: decimal('average_price').notNull(),
    realizedPnl: decimal('realized_pnl').notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.symbol] })],
)

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userRef(),
    symbol: text('symbol')
      .notNull()
      .references(() => instruments.symbol),
    side: orderSideEnum('side').notNull(),
    type: orderTypeEnum('type').notNull(),
    status: orderStatusEnum('status').notNull(),
    quantity: decimal('quantity').notNull(),
    limitPrice: decimal('limit_price'),
    /** Caixa reservado por uma compra limitada, devolvido no cancelamento ou no fill. */
    reserved: decimal('reserved'),
    fillPrice: decimal('fill_price'),
    fee: decimal('fee'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
  },
  (table) => [
    index('orders_user_created_idx').on(table.userId, table.createdAt),
    index('orders_status_symbol_idx').on(table.status, table.symbol),
  ],
)
