import { clientMessageSchema, type ServerMessage } from '@b-hook/contracts'
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
  const pending = new Map<string, Tick>()

  const send = (socket: WebSocket, message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  const stopTicks = hub.onTick((tick) => pending.set(tick.symbol, tick))
  const flushTimer = setInterval(() => {
    if (pending.size === 0) return
    const ticks = [...pending.values()]
    pending.clear()
    for (const [socket, client] of clients) {
      for (const tick of ticks) {
        if (client.symbols.has(tick.symbol)) send(socket, { type: 'tick', ...tick })
      }
    }
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
          if (tick) send(socket, { type: 'tick', ...tick })
        } else {
          client.symbols.delete(symbol)
        }
      }
    })

    socket.on('close', () => clients.delete(socket))
  })
}
