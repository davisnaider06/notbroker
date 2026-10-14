import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireDirLock } from './dir-lock.ts'

const HEARTBEAT_MS = 40
let dir: string
let lockPath: string

/** Processo vivo que não é este: o pai do worker do Vitest. */
const livePid = process.ppid
/** PID de um processo que já terminou. */
const deadPid = spawnSync(process.execPath, ['-e', '']).pid

function writeLock(pid: number, ageMs: number): void {
  writeFileSync(lockPath, String(pid))
  const time = new Date(Date.now() - ageMs)
  utimesSync(lockPath, time, time)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notbroker-lock-'))
  lockPath = join(dir, 'pglite.lock')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('trava da pasta do PGlite', () => {
  it('cria, grava o PID e apaga ao liberar', async () => {
    const release = await acquireDirLock(lockPath, { heartbeatMs: HEARTBEAT_MS })
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))
    release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('assume trava de processo morto', async () => {
    writeLock(deadPid ?? 0, 0)
    const release = await acquireDirLock(lockPath, { heartbeatMs: HEARTBEAT_MS })
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))
    release()
  })

  it('recusa quando o dono está vivo e batendo', async () => {
    writeLock(livePid, 0)
    await expect(acquireDirLock(lockPath, { heartbeatMs: HEARTBEAT_MS })).rejects.toThrow(
      `processo ${livePid}`,
    )
  })

  it('assume trava com PID reaproveitado: vivo, mas sem batimento', async () => {
    // O caso de 09/10: API morta, PC hibernou, o PID virou de outro programa.
    writeLock(livePid, 60 * 60_000)
    const release = await acquireDirLock(lockPath, { heartbeatMs: HEARTBEAT_MS })
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))
    release()
  })

  it('recusa se o dono parado volta a bater durante a espera (acabou de acordar)', async () => {
    writeLock(livePid, 60 * 60_000)
    const beat = setInterval(() => utimesSync(lockPath, new Date(), new Date()), 10)
    try {
      await expect(acquireDirLock(lockPath, { heartbeatMs: HEARTBEAT_MS })).rejects.toThrow(
        'já está aberto',
      )
    } finally {
      clearInterval(beat)
    }
  })

  it('o dono mantém o batimento e não apaga trava que outro assumiu', async () => {
    const release = await acquireDirLock(lockPath, { heartbeatMs: HEARTBEAT_MS })
    writeLock(process.pid, 60 * 60_000)
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 2))
    expect(Date.now() - statSync(lockPath).mtimeMs).toBeLessThan(HEARTBEAT_MS * 3)

    writeFileSync(lockPath, String(livePid))
    release()
    expect(readFileSync(lockPath, 'utf8')).toBe(String(livePid))
  })
})
