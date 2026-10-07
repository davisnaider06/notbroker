import { CURRENCIES } from '@b-hook/contracts'
import type { Executor } from '../db/client.ts'
import { instruments, wallets } from '../db/schema/index.ts'
import { CATALOG } from '../market-data/catalog.ts'
import { STARTING_BALANCES } from './ledger.ts'

/** Toda conta nova nasce com uma carteira por moeda e o saldo inicial de treino. */
export async function openAccount(db: Executor, userId: string): Promise<void> {
  await db
    .insert(wallets)
    .values(
      CURRENCIES.map((currency) => ({ userId, currency, balance: STARTING_BALANCES[currency] })),
    )
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
