import { ACCOUNT_CURRENCY, type AccountKind, STARTING_BALANCE } from '@notbroker/contracts'
import { and, eq } from 'drizzle-orm'
import type { Executor } from '../db/client.ts'
import { instruments, wallets } from '../db/schema/index.ts'
import { CATALOG } from '../market-data/catalog.ts'

/** Toda conta nova nasce com a carteira demo (saldo de treino) e a real, vazia. */
export async function openAccount(db: Executor, userId: string): Promise<void> {
  await db
    .insert(wallets)
    .values([
      {
        userId,
        account: 'demo',
        currency: ACCOUNT_CURRENCY,
        balance: STARTING_BALANCE,
        startingBalance: STARTING_BALANCE,
      },
      { userId, account: 'real', currency: ACCOUNT_CURRENCY, balance: '0', startingBalance: '0' },
    ])
    .onConflictDoNothing()
}

/** Filtro da carteira em reais de uma das contas do usuário. */
export function walletOf(userId: string, account: AccountKind) {
  return and(
    eq(wallets.userId, userId),
    eq(wallets.account, account),
    eq(wallets.currency, ACCOUNT_CURRENCY),
  )
}

/** Mantém a tabela de instrumentos igual ao catálogo do código (necessária para as FKs). */
export async function syncCatalog(db: Executor): Promise<void> {
  for (const instrument of CATALOG) {
    await db
      .insert(instruments)
      .values(instrument)
      .onConflictDoUpdate({
        target: instruments.symbol,
        set: { name: instrument.name, quantityDecimals: instrument.quantityDecimals },
      })
  }
}
