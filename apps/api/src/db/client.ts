import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import * as schema from './schema/index.ts'

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Funções de domínio aceitam tanto o db quanto uma transação aberta. */
export type Executor = Database | Transaction

export interface DatabaseHandle {
  db: Database
  close: () => Promise<void>
}

const migrationsFolder = resolve(import.meta.dirname, '../../drizzle')

/**
 * Com DATABASE_URL usa Postgres de verdade; sem ela, PGlite (Postgres em WASM, persistido em disco).
 * Mesmo dialeto, mesmas migrations: o que roda em dev roda em produção.
 */
export async function openDatabase(options: {
  url: string | undefined
  pgliteDir: string
}): Promise<DatabaseHandle> {
  if (options.url) {
    const client = postgres(options.url, { max: 10 })
    const db = drizzlePostgres({ client, schema })
    await migratePostgres(db, { migrationsFolder })
    return { db, close: () => client.end() }
  }

  if (options.pgliteDir !== 'memory://') mkdirSync(options.pgliteDir, { recursive: true })
  const client = new PGlite(options.pgliteDir)
  const db = drizzlePglite({ client, schema })
  await migratePglite(db, { migrationsFolder })
  return { db, close: () => client.close() }
}
