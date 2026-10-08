import type {
  CandleDto,
  CandleInterval,
  FxRatesDto,
  InstrumentDto,
  OrderDto,
  PlaceOrderInput,
  PositionDto,
  WalletDto,
} from '@b-hook/contracts'

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
  portfolio: () => request<{ wallets: WalletDto[]; positions: PositionDto[] }>('/api/portfolio'),
  orders: () => request<OrderDto[]>('/api/orders'),
  fx: () => request<FxRatesDto>('/api/fx'),
  placeOrder: (input: PlaceOrderInput) =>
    request<OrderDto>('/api/orders', { method: 'POST', body: JSON.stringify(input) }),
  cancelOrder: (id: string) => request<OrderDto>(`/api/orders/${id}/cancel`, { method: 'POST' }),
}

export const queryKeys = {
  instruments: ['instruments'] as const,
  candles: (symbol: string, interval: CandleInterval) => ['candles', symbol, interval] as const,
  portfolio: ['portfolio'] as const,
  orders: ['orders'] as const,
  fx: ['fx'] as const,
}
