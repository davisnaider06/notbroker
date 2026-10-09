import type { CandleDto, CandleInterval } from '@notbroker/contracts'
import type { FastifyBaseLogger } from 'fastify'
import type { Instrument } from './catalog.ts'

export interface Tick {
  symbol: string
  price: string
  /** Epoch em ms do negócio na origem. */
  time: number
}

export type TickListener = (tick: Tick) => void

export type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

/** Contrato de toda fonte de preço. Trocar Yahoo por um feed pago da B3 é escrever outro desses. */
export interface MarketDataProvider {
  readonly name: string
  start(instruments: readonly Instrument[], onTick: TickListener): void
  candles(instrument: Instrument, interval: CandleInterval): Promise<CandleDto[]>
  stop(): void
}

export class UpstreamError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider}: ${detail}`)
    this.name = 'UpstreamError'
  }
}

export async function fetchJson(
  provider: string,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new UpstreamError(provider, `HTTP ${response.status} em ${url}`)
  return response.json()
}

interface ReconnectingSocketOptions {
  name: string
  url: string
  logger: Logger
  onOpen: (socket: WebSocket) => void
  onMessage: (data: string, socket: WebSocket) => void
}

/**
 * WebSocket que se reconecta sozinho com backoff exponencial (1s → 30s).
 * Usa o WebSocket nativo do Node 24, sem dependência.
 */
export class ReconnectingSocket {
  #socket: WebSocket | undefined
  #attempt = 0
  #stopped = false
  #timer: NodeJS.Timeout | undefined
  readonly #options: ReconnectingSocketOptions

  constructor(options: ReconnectingSocketOptions) {
    this.#options = options
  }

  connect(): void {
    const { name, url, logger, onOpen, onMessage } = this.#options
    const socket = new WebSocket(url)
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#attempt = 0
      logger.info(`[${name}] websocket conectado`)
      onOpen(socket)
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') onMessage(event.data, socket)
    })
    socket.addEventListener('close', () => {
      if (this.#stopped) return
      const delay = Math.min(30_000, 1000 * 2 ** this.#attempt++)
      logger.warn(`[${name}] websocket caiu, reconectando em ${delay}ms`)
      this.#timer = setTimeout(() => this.connect(), delay)
    })
    socket.addEventListener('error', () => {
      logger.warn(`[${name}] erro no websocket`)
    })
  }

  close(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#socket?.close()
  }
}
