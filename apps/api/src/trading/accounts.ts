import { ACCOUNT_CURRENCY, STARTING_BALANCE } from '@notbroker/contracts'
import type { Executor } from '../db/client.ts'
import { instruments, wallets } from '../db/schema/index.ts'
import { CATALOG } from '../market-data/catalog.ts'

/** Toda conta nova nasce com uma carteira em reais e o saldo inicial de treino. */
export async function openAccount(db: Executor, userId: string): Promise<void> {
  await db
    .insert(wallets)
    .values({ userId, currency: ACCOUNT_CURRENCY, balance: STARTING_BALANCE })
    .onConflictDoNothing()
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
