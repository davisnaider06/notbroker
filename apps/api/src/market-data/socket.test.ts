import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReconnectingSocket } from './provider.ts'

/** WebSocket falso: abre sozinho e nunca manda nada, como a conexão travada que medimos. */
class SilentSocket extends EventTarget {
  static created: SilentSocket[] = []
  closed = false
  readonly url: string
  constructor(url: string) {
    super()
    this.url = url
    SilentSocket.created.push(this)
    queueMicrotask(() => this.dispatchEvent(new Event('open')))
  }
  close() {
    this.closed = true
  }
}

const logger = { info: () => {}, warn: () => {}, error: () => {} }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  SilentSocket.created = []
})

describe('ReconnectingSocket', () => {
  it('conexão muda além do prazo é abandonada e refeita', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', SilentSocket)
    const socket = new ReconnectingSocket({
      name: 'teste',
      url: 'wss://x',
      logger,
      onOpen: () => {},
      onMessage: () => {},
      idleTimeoutMs: 5_000,
    })
    socket.connect()
    await vi.advanceTimersByTimeAsync(4_900)
    expect(SilentSocket.created).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(200 + 1_000)
    expect(SilentSocket.created[0]?.closed).toBe(true)
    expect(SilentSocket.created).toHaveLength(2)
    socket.close()
  })

  it('sem prazo configurado, silêncio não derruba a conexão', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', SilentSocket)
    const socket = new ReconnectingSocket({
      name: 'teste',
      url: 'wss://x',
      logger,
      onOpen: () => {},
      onMessage: () => {},
    })
    socket.connect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(SilentSocket.created).toHaveLength(1)
    socket.close()
  })
})
