import { useEffect, useState } from 'react'

/** Horário atual, re-renderizando a cada `intervalMs`. Para contagens regressivas na tela. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
