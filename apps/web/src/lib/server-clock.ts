/** Amostras recentes de ping/pong: a de menor ida e volta é a que menos erra a diferença. */
const MAX_SAMPLES = 8

interface Sample {
  roundTripMs: number
  offsetMs: number
}

const samples: Sample[] = []
let offsetMs = 0

/**
 * Horário no relógio do servidor, que decide expiração e janela de entrada. O relógio do PC pode
 * estar segundos fora; contar por ele faria o resultado aparecer antes da contagem zerar.
 */
export function serverNow(): number {
  return Date.now() + offsetMs
}

/** Registra um pong. Supõe ida e volta simétricas: o servidor respondeu no meio do caminho. */
export function recordPong(sentAt: number, serverTime: number, receivedAt = Date.now()): void {
  const roundTripMs = receivedAt - sentAt
  if (roundTripMs < 0) return
  samples.push({ roundTripMs, offsetMs: serverTime - (sentAt + roundTripMs / 2) })
  if (samples.length > MAX_SAMPLES) samples.shift()
  const best = samples.reduce((a, b) => (b.roundTripMs < a.roundTripMs ? b : a))
  offsetMs = best.offsetMs
}

/** Só para testes. */
export function resetServerClock(): void {
  samples.length = 0
  offsetMs = 0
}
