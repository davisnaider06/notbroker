import { z } from 'zod'

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
  })
  .refine((env) => Boolean(env.ALPACA_KEY_ID) === Boolean(env.ALPACA_SECRET_KEY), {
    message: 'ALPACA_KEY_ID e ALPACA_SECRET_KEY vão juntas',
  })

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`Variáveis de ambiente inválidas:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
