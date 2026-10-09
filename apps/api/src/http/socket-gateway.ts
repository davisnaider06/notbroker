import { clientMessageSchema, type ServerMessage } from '@notbroker/contracts'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { Auth } from '../auth/auth.ts'
import { currentUser, requireUser } from '../auth/session.ts'
import { findInstrument } from '../market-data/catalog.ts'
import type { MarketDataHub } from '../market-data/hub.ts'
import type { Tick } from '../market-data/provider.ts'
import type { BinaryService } from '../trading/binary-service.ts'

/** BTC chega a dezenas de negócios por segundo; o navegador só precisa de ~4 atualizações/s. */
const FLUSH_INTERVAL_MS = 250

/** Agregado dos negócios de um ativo dentro de uma janela de envio. */
export interface TickWindow extends Tick {
  open: string
  high: string
  low: string
}

const MINUTE_MS = 60_000

/** Soma um negócio à janela: mantém a abertura, estende máxima/mínima e atualiza o último preço. */
export function mergeTick(window: TickWindow | undefined, tick: Tick): TickWindow {
  if (!window) return { ...tick, open: tick.price, high: tick.price, low: tick.price }
  const price = Number(tick.price)
  return {
    ...tick,
    open: window.open,
    high: price > Number(window.high) ? tick.price : window.high,
    low: price < Number(window.low) ? tick.price : window.low,
  }
}

interface Client {
  userId: string
  symbols: Set<string>
}

/**
 * Um WebSocket por aba em /ws. O cliente assina símbolos e recebe ticks agregados; atualizações
 * das próprias operações chegam sem assinatura. A sessão é validada antes do upgrade.
 */
export function registerSocketGateway(
  app: FastifyInstance,
  auth: Auth,
  hub: MarketDataHub,
  binaryService: BinaryService,
): void {
  const clients = new Map<WebSocket, Client>()
  const pending = new Map<string, TickWindow>()

  const send = (socket: WebSocket, message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  const broadcast = (windows: TickWindow[]) => {
    for (const [socket, client] of clients) {
      for (const window of windows) {
        if (client.symbols.has(window.symbol)) send(socket, { type: 'tick', ...window })
      }
    }
  }

  const stopTicks = hub.onTick((tick) => {
    const current = pending.get(tick.symbol)
    // Uma janela nunca atravessa a virada do minuto: senão a máxima/mínima do fim de uma vela
    // vazaria para a próxima. Todo intervalo do gráfico é múltiplo de 1 min.
    if (current && Math.floor(current.time / MINUTE_MS) !== Math.floor(tick.time / MINUTE_MS)) {
      pending.delete(tick.symbol)
      broadcast([current])
    }
    pending.set(tick.symbol, mergeTick(pending.get(tick.symbol), tick))
  })
  const flushTimer = setInterval(() => {
    if (pending.size === 0) return
    const windows = [...pending.values()]
    pending.clear()
    broadcast(windows)
  }, FLUSH_INTERVAL_MS)

  const stopTrades = binaryService.onTradeUpdate((userId, trade) => {
    for (const [socket, client] of clients) {
      if (client.userId === userId) send(socket, { type: 'trade', trade })
    }
  })

  app.addHook('onClose', async () => {
    clearInterval(flushTimer)
    stopTicks()
    stopTrades()
  })

  app.get('/ws', { websocket: true, preValidation: requireUser(auth) }, (socket, request) => {
    const client: Client = { userId: currentUser(request).id, symbols: new Set() }
    clients.set(socket, client)

    socket.on('message', (raw) => {
      let payload: unknown
      try {
        payload = JSON.parse(raw.toString())
      } catch {
        return send(socket, { type: 'error', message: 'JSON inválido' })
      }
      const parsed = clientMessageSchema.safeParse(payload)
      if (!parsed.success) return send(socket, { type: 'error', message: 'Mensagem inválida' })

      const message = parsed.data
      for (const symbol of message.symbols) {
        if (!findInstrument(symbol)) continue
        if (message.type === 'subscribe') {
          client.symbols.add(symbol)
          // Snapshot imediato para a tela não ficar vazia até o próximo negócio. Vai com o horário
          // real do negócio, não o de agora: o gráfico usa esse tempo para escolher o candle.
          const tick = hub.lastTick(symbol)
          if (tick) {
            send(socket, {
              type: 'tick',
              ...tick,
              open: tick.price,
              high: tick.price,
              low: tick.price,
            })
          }
        } else {
          client.symbols.delete(symbol)
        }
      }
    })

    socket.on('close', () => clients.delete(socket))
  })
}
