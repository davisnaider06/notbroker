import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
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

  if (options.pgliteDir === 'memory://') {
    const client = new PGlite(options.pgliteDir)
    const db = drizzlePglite({ client, schema })
    await migratePglite(db, { migrationsFolder })
    return { db, close: () => client.close() }
  }

  mkdirSync(options.pgliteDir, { recursive: true })
  const releaseLock = acquireDirLock(options.pgliteDir)
  const client = new PGlite(options.pgliteDir)
  const db = drizzlePglite({ client, schema })
  await migratePglite(db, { migrationsFolder })
  return {
    db,
    close: async () => {
      await client.close()
      releaseLock()
    },
  }
}

/**
 * PGlite não trava a pasta: dois processos abrindo o mesmo diretório (um `node` órfão de outra
 * sessão, por exemplo) perdem escritas em silêncio e podem corromper o banco. O lock guarda o PID
 * do dono; se esse processo já morreu (kill forçado, restart do --watch), o lock é retomado.
 */
function acquireDirLock(dir: string): () => void {
  const lockPath = resolve(dir, '..', `${basename(dir)}.lock`)
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const owner = Number(readFileSync(lockPath, 'utf8'))
    if (owner !== process.pid && isAlive(owner)) {
      throw new Error(
        `O banco em ${dir} já está aberto pelo processo ${owner}. Encerre-o antes de subir outra API.`,
      )
    }
    writeFileSync(lockPath, String(process.pid))
  }
  return () => rmSync(lockPath, { force: true })
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: o processo existe, só não é nosso.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
