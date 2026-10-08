import type { FxRatesDto } from '@b-hook/contracts'
import type { Logger } from './provider.ts'
import { fetchYahooPrice } from './providers/yahoo.ts'

const CACHE_MS = 60_000

export interface FxSource {
  rates(): Promise<FxRatesDto>
}

/**
 * Câmbio para exibição, do Yahoo (mesma fonte não oficial das ações). Cache de 1 min: câmbio
 * comercial anda pouco, e a tela só converte valores, não negocia moeda.
 * Se o Yahoo falhar, devolve a última cotação boa; sem nenhuma, a rota responde erro.
 */
export class YahooFx implements FxSource {
  readonly #logger: Logger
  #cached: FxRatesDto | undefined
  #pending: Promise<FxRatesDto> | undefined

  constructor(logger: Logger) {
    this.#logger = logger
  }

  async rates(): Promise<FxRatesDto> {
    if (this.#cached && Date.now() - this.#cached.updatedAt < CACHE_MS) return this.#cached
    this.#pending ??= this.#fetch().finally(() => {
      this.#pending = undefined
    })
    try {
      return await this.#pending
    } catch (error) {
      if (!this.#cached) throw error
      this.#logger.warn({ err: error }, '[fx] falha ao atualizar câmbio; usando a última cotação')
      return this.#cached
    }
  }

  async #fetch(): Promise<FxRatesDto> {
    // EURUSD=X e GBPUSD=X vêm em USD por moeda; BRL=X já vem em BRL por USD.
    const [eurUsd, gbpUsd, usdBrl] = await Promise.all([
      fetchYahooPrice('EURUSD=X'),
      fetchYahooPrice('GBPUSD=X'),
      fetchYahooPrice('BRL=X'),
    ])
    this.#cached = {
      perUsd: { USD: 1, EUR: 1 / eurUsd, GBP: 1 / gbpUsd, BRL: usdBrl },
      updatedAt: Date.now(),
    }
    return this.#cached
  }
}
