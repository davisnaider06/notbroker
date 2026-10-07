import { placeOrderSchema } from '@b-hook/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Auth } from '../../auth/auth.ts'
import { currentUser, requireUser } from '../../auth/session.ts'
import type { OrderService } from '../../trading/order-service.ts'

const orderParams = z.object({ id: z.uuid() })

export function registerTradingRoutes(
  app: FastifyInstance,
  auth: Auth,
  orderService: OrderService,
): void {
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser(auth))

    scope.get('/api/me', async (request) => currentUser(request))

    scope.get('/api/portfolio', async (request) => orderService.portfolio(currentUser(request).id))

    scope.get('/api/orders', async (request) => orderService.listOrders(currentUser(request).id))

    scope.post('/api/orders', async (request, reply) => {
      const input = placeOrderSchema.parse(request.body)
      const order = await orderService.place(currentUser(request).id, input)
      return reply.status(201).send(order)
    })

    scope.post('/api/orders/:id/cancel', async (request) => {
      const { id } = orderParams.parse(request.params)
      return orderService.cancel(currentUser(request).id, id)
    })
  })
}
