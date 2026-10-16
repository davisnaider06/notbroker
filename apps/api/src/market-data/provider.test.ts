import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson, UpstreamError } from './provider.ts'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchJson', () => {
  it('tenta de novo quando a chamada trava ou cai', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok([1, 2]))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchJson('teste', 'https://x')).resolves.toEqual([1, 2])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('tenta de novo em 5xx, mas não em 4xx', async () => {
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(ok({ a: 1 }))
    vi.stubGlobal('fetch', flaky)
    await expect(fetchJson('teste', 'https://x')).resolves.toEqual({ a: 1 })

    const notFound = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', notFound)
    await expect(fetchJson('teste', 'https://x')).rejects.toBeInstanceOf(UpstreamError)
    expect(notFound).toHaveBeenCalledTimes(1)
  })

  it('depois das tentativas, falha como provedor indisponível', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError')))
    await expect(fetchJson('teste', 'https://x')).rejects.toThrow(UpstreamError)
  })
})
