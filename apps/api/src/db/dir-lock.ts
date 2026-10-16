import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

export interface DirLockOptions {
  /** De quanto em quanto tempo o dono toca no arquivo para provar que está vivo. */
  heartbeatMs?: number
}

const DEFAULT_HEARTBEAT_MS = 5000

/**
 * Trava de processo único para a pasta do PGlite, que não se trava sozinha: dois processos no mesmo
 * diretório perdem escritas em silêncio e podem corromper o banco.
 *
 * Só o PID não basta: depois de matar a API e hibernar, o Windows reaproveitou o PID para outro
 * programa, e a trava ficou presa a um processo que não era o dono. Por isso o dono atualiza o
 * horário do arquivo a cada `heartbeatMs`. A trava só vale com PID vivo E batimento recente. Com
 * PID vivo e batimento parado (PID reaproveitado ou dono que acabou de acordar), espera dois
 * batimentos: se o arquivo não se mexer, o dono morreu.
 */
export async function acquireDirLock(
  lockPath: string,
  options: DirLockOptions = {},
): Promise<() => void> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const staleMs = heartbeatMs * 3

  if (!tryCreate(lockPath)) {
    const owner = readOwner(lockPath)
    if (owner !== process.pid && isAlive(owner)) {
      const lastBeat = mtimeMs(lockPath)
      if (Date.now() - lastBeat < staleMs) throw lockedError(lockPath, owner)
      await sleep(heartbeatMs * 2)
      if (mtimeMs(lockPath) !== lastBeat) throw lockedError(lockPath, owner)
    }
    writeFileSync(lockPath, String(process.pid))
  }

  const heartbeat = setInterval(() => {
    const now = new Date()
    try {
      utimesSync(lockPath, now, now)
    } catch {
      // Arquivo apagado na mão: recria para não deixar o banco sem dono.
      writeFileSync(lockPath, String(process.pid))
    }
  }, heartbeatMs)
  heartbeat.unref()

  return () => {
    clearInterval(heartbeat)
    // Só apaga se ainda for nossa: outro processo pode ter assumido uma trava dada como morta.
    if (readOwner(lockPath) === process.pid) rmSync(lockPath, { force: true })
  }
}

function tryCreate(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

function readOwner(lockPath: string): number {
  try {
    return Number(readFileSync(lockPath, 'utf8'))
  } catch {
    return Number.NaN
  }
}

function mtimeMs(lockPath: string): number {
  return statSync(lockPath).mtimeMs
}

function lockedError(lockPath: string, owner: number): Error {
  return new Error(
    `O banco já está aberto pelo processo ${owner} (trava em ${lockPath}). Encerre-o antes de subir outra API.`,
  )
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
