import { z } from 'zod'

/** Placeholder do .env.example. Público no GitHub: em produção, assina sessão que qualquer um forja. */
export const EXAMPLE_AUTH_SECRET = 'troque-por-um-segredo-com-32-caracteres-ou-mais'

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3333),
    DATABASE_URL: z.url().optional(),
    PGLITE_DIR: z.string().default('.data/pglite'),
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET precisa de 32+ caracteres'),
    BETTER_AUTH_URL: z.url().default('http://localhost:5173'),
    ALPACA_KEY_ID: z.string().min(1).optional(),
    ALPACA_SECRET_KEY: z.string().min(1).optional(),
    YAHOO_POLL_MS: z.coerce.number().int().min(5000).default(15000),
    /** Ligue quando houver proxy/load balancer na frente: o IP do cliente vem do X-Forwarded-For. */
    TRUST_PROXY: z.stringbool().default(false),
    /** Pasta do build do front. Sem ela, em produção a API usa apps/web/dist. */
    WEB_DIST: z.string().min(1).optional(),
    /** Chaves da VizzionPay. Sem elas, a conta real (depósito e saque) fica desligada. */
    VIZZIONPAY_PUBLIC_KEY: z.string().min(1).optional(),
    VIZZIONPAY_SECRET_KEY: z.string().min(1).optional(),
    VIZZIONPAY_URL: z.url().default('https://app.vizzionpay.com.br/api/v1'),
    /**
     * URL pública da API, base do webhook do gateway. Sem ela, vale a origem de BETTER_AUTH_URL;
     * em localhost o webhook não é enviado (o gateway não alcança) e a consulta cobre.
     */
    PUBLIC_URL: z.url().optional(),
    /** E-mails que podem criar conta, separados por vírgula. Vazio = cadastro aberto. */
    ALLOWED_EMAILS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? '')
          .split(',')
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
  })
  .refine((env) => Boolean(env.ALPACA_KEY_ID) === Boolean(env.ALPACA_SECRET_KEY), {
    message: 'ALPACA_KEY_ID e ALPACA_SECRET_KEY vão juntas',
  })
  .refine((env) => Boolean(env.VIZZIONPAY_PUBLIC_KEY) === Boolean(env.VIZZIONPAY_SECRET_KEY), {
    message: 'VIZZIONPAY_PUBLIC_KEY e VIZZIONPAY_SECRET_KEY vão juntas',
  })
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' || !env.VIZZIONPAY_PUBLIC_KEY || env.ALLOWED_EMAILS.length > 0,
    {
      message: 'Com dinheiro real ligado em produção, ALLOWED_EMAILS é obrigatório',
      path: ['ALLOWED_EMAILS'],
    },
  )
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.BETTER_AUTH_SECRET !== EXAMPLE_AUTH_SECRET,
    {
      message: 'BETTER_AUTH_SECRET ainda é o valor do .env.example: gere um segredo novo',
      path: ['BETTER_AUTH_SECRET'],
    },
  )

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`Variáveis de ambiente inválidas:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
