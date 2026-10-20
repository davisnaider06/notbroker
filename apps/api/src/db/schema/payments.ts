import { DEPOSIT_STATUSES, PIX_KEY_TYPES, WITHDRAWAL_STATUSES } from '@notbroker/contracts'
import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { decimal, userRef } from './trading.ts'

export const depositStatusEnum = pgEnum('deposit_status', DEPOSIT_STATUSES)
export const withdrawalStatusEnum = pgEnum('withdrawal_status', WITHDRAWAL_STATUSES)
export const pixKeyTypeEnum = pgEnum('pix_key_type', PIX_KEY_TYPES)

/**
 * Depósito Pix na conta real. O `id` vai como `identifier` para o gateway: é por ele que o
 * webhook encontra o depósito. O crédito acontece uma vez só, na troca de pending para paid.
 */
export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userRef(),
    amount: decimal('amount').notNull(),
    status: depositStatusEnum('status').notNull().default('pending'),
    /** ID da transação no gateway. Nulo só se a criação lá falhou. */
    gatewayId: text('gateway_id').unique(),
    pixCode: text('pix_code'),
    /** CPF enviado como pagador. */
    document: text('document').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** Última consulta ao gateway: o sweeper não repete a mesma antes do intervalo. */
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (table) => [
    index('deposits_user_created_idx').on(table.userId, table.createdAt),
    index('deposits_status_idx').on(table.status),
  ],
)

/**
 * Saque Pix da conta real. O valor sai do saldo no pedido; se o gateway recusar ou cancelar,
 * volta. O `id` vai como `identifier` da transferência.
 */
export const withdrawals = pgTable(
  'withdrawals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userRef(),
    amount: decimal('amount').notNull(),
    fee: decimal('fee'),
    status: withdrawalStatusEnum('status').notNull().default('requested'),
    gatewayId: text('gateway_id').unique(),
    ownerName: text('owner_name').notNull(),
    document: text('document').notNull(),
    pixKeyType: pixKeyTypeEnum('pix_key_type').notNull(),
    pixKey: text('pix_key').notNull(),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (table) => [
    index('withdrawals_user_created_idx').on(table.userId, table.createdAt),
    index('withdrawals_status_idx').on(table.status),
  ],
)
