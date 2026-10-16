import type { FastifyInstance } from 'fastify'

/**
 * Política da página servida pela API em produção. O front só fala com a própria origem (`/api` e
 * `/ws`), não carrega script de fora e não pode ser embutido em iframe de outro site.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // React e lightweight-charts escrevem estilo inline nos elementos.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** Headers de segurança em toda resposta. HSTS só quando a API está atrás de HTTPS (produção). */
export function registerSecurityHeaders(app: FastifyInstance, options: { hsts: boolean }): void {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'strict-origin-when-cross-origin')
    reply.header('cross-origin-opener-policy', 'same-origin')
    if (options.hsts) reply.header('strict-transport-security', 'max-age=31536000')
  })
}
