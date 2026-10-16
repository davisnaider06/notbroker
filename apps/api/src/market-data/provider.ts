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
  /**
   * Empurra cada negócio na hora em que acontece (WebSocket). Polling ou fonte com atraso não é
   * tempo real: serve para gráfico, nunca para aceitar operação.
   */
  readonly realtime: boolean
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

/**
 * Medido (16/10/2026): a Binance REST responde em ~2,7 s, mas 1 em cada 3 chamadas trava até o
 * timeout, com conexão nova ou reaproveitada; o Yahoo responde em < 1 s e às vezes não conecta.
 * Tentativa travada não é tentativa lenta: desistir em 5 s e tentar de novo resolveu 10 de 10.
 */
const ATTEMPT_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 300

/**
 * GET de JSON com nova tentativa para timeout, falha de rede, 429 e 5xx. Qualquer falha que sobra
 * vira UpstreamError: a API responde "provedor indisponível", nunca "erro interno".
 */
export async function fetchJson(
  provider: string,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  let lastError = 'sem resposta'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      })
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
      // 4xx (fora 429) é pedido errado: repetir dá o mesmo resultado.
      if (response.status !== 429 && response.status < 500) break
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
  }
  throw new UpstreamError(provider, `${lastError} em ${url}`)
}

interface ReconnectingSocketOptions {
  name: string
  url: string
  logger: Logger
  onOpen: (socket: WebSocket) => void
  onMessage: (data: string, socket: WebSocket) => void
  /**
   * Sem nenhuma mensagem por esse tempo, a conexão é dada como travada e refeita. Medido em
   * 16/10/2026: a Binance chegou a ficar ~60 s muda com a conexão aberta, e só fechou depois disso.
   * Omitir em fonte que fica quieta de verdade (ações fora do pregão).
   */
  idleTimeoutMs?: number
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
  #idleTimer: NodeJS.Timeout | undefined
  readonly #options: ReconnectingSocketOptions

  constructor(options: ReconnectingSocketOptions) {
    this.#options = options
  }

  connect(): void {
    const { name, url, logger, onOpen, onMessage } = this.#options
    const socket = new WebSocket(url)
    this.#socket = socket
    // Eventos de uma conexão já abandonada (travada e substituída) não contam mais.
    const current = () => this.#socket === socket

    socket.addEventListener('open', () => {
      if (!current()) return
      this.#attempt = 0
      logger.info(`[${name}] websocket conectado`)
      this.#watchIdle(socket)
      onOpen(socket)
    })
    socket.addEventListener('message', (event) => {
      if (!current()) return
      this.#watchIdle(socket)
      if (typeof event.data === 'string') onMessage(event.data, socket)
    })
    socket.addEventListener('close', () => {
      if (this.#stopped || !current()) return
      logger.warn(`[${name}] websocket caiu`)
      this.#reconnect()
    })
    socket.addEventListener('error', () => {
      if (current()) logger.warn(`[${name}] erro no websocket`)
    })
  }

  /** Rearma o vigia: se a conexão ficar muda, abandona ela e abre outra. */
  #watchIdle(socket: WebSocket): void {
    const { idleTimeoutMs, name, logger } = this.#options
    if (idleTimeoutMs === undefined) return
    clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      if (this.#stopped || this.#socket !== socket) return
      logger.warn(`[${name}] websocket mudo há ${idleTimeoutMs} ms, reconectando`)
      // Conexão travada pode demorar a fechar: não esperamos o close dela para abrir a próxima.
      this.#socket = undefined
      socket.close()
      this.#reconnect()
    }, idleTimeoutMs)
  }

  #reconnect(): void {
    clearTimeout(this.#idleTimer)
    clearTimeout(this.#timer)
    const delay = Math.min(30_000, 1000 * 2 ** this.#attempt++)
    this.#options.logger.warn(`[${this.#options.name}] reconectando em ${delay}ms`)
    this.#timer = setTimeout(() => this.connect(), delay)
  }

  close(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    clearTimeout(this.#idleTimer)
    this.#socket?.close()
  }
}
