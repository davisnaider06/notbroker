import { describe, expect, it } from 'vitest'
import { EXAMPLE_AUTH_SECRET, loadEnv } from './env.ts'

const REAL_SECRET = 'um-segredo-gerado-de-verdade-com-mais-de-32-caracteres'

describe('variáveis de ambiente', () => {
  it('recusa o segredo do .env.example em produção', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'production', BETTER_AUTH_SECRET: EXAMPLE_AUTH_SECRET }),
    ).toThrow('BETTER_AUTH_SECRET ainda é o valor do .env.example')
  })

  it('aceita o segredo de exemplo fora de produção', () => {
    expect(loadEnv({ BETTER_AUTH_SECRET: EXAMPLE_AUTH_SECRET }).NODE_ENV).toBe('development')
  })

  it('aceita segredo próprio em produção', () => {
    const env = loadEnv({ NODE_ENV: 'production', BETTER_AUTH_SECRET: REAL_SECRET })
    expect(env.TRUST_PROXY).toBe(false)
  })

  it('o placeholder continua igual ao do .env.example', async () => {
    const { readFileSync } = await import('node:fs')
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    expect(example).toContain(`BETTER_AUTH_SECRET=${EXAMPLE_AUTH_SECRET}\n`)
  })
})
