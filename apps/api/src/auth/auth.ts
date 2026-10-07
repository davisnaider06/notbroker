import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Env } from '../config/env.ts'
import type { Database } from '../db/client.ts'
import * as schema from '../db/schema/index.ts'
import { openAccount } from '../trading/accounts.ts'

export function createAuth(db: Database, env: Env) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await openAccount(db, user.id)
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
