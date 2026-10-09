import type {
  AccountDto,
  CandleDto,
  CandleInterval,
  FxRatesDto,
  InstrumentDto,
  OpenTradeInput,
  TradeDto,
} from '@notbroker/contracts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    ...(init?.body ? { headers: { 'content-type': 'application/json' } } : {}),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Erro ${response.status}`,
    )
  }
  return body as T
}

export const api = {
  instruments: () => request<InstrumentDto[]>('/api/instruments'),
  candles: (symbol: string, interval: CandleInterval) =>
    request<CandleDto[]>(`/api/instruments/${symbol}/candles?interval=${interval}`),
  fx: () => request<FxRatesDto>('/api/fx'),
  account: () => request<AccountDto>('/api/account'),
  trades: () => request<TradeDto[]>('/api/trades'),
  openTrade: (input: OpenTradeInput) =>
    request<TradeDto>('/api/trades', { method: 'POST', body: JSON.stringify(input) }),
}

export const queryKeys = {
  instruments: ['instruments'] as const,
  candles: (symbol: string, interval: CandleInterval) => ['candles', symbol, interval] as const,
  account: ['account'] as const,
  trades: ['trades'] as const,
  fx: ['fx'] as const,
}
