import { useEffect, useState } from 'react'
import { serverNow } from './server-clock.ts'

/**
 * Horário atual no relógio do servidor, re-renderizando a cada `intervalMs`. Para contagens
 * regressivas na tela.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
