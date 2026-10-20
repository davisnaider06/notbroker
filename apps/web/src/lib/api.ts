import type {
  AccountDto,
  AccountKind,
  CandleDto,
  CandleInterval,
  CreateDepositInput,
  CreateWithdrawalInput,
  DepositDto,
  FxRatesDto,
  InstrumentDto,
  OpenTradeInput,
  PaymentsDto,
  ResetAccountInput,
  TradeDto,
  WithdrawalDto,
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
  account: (kind: AccountKind) => request<AccountDto>(`/api/account?account=${kind}`),
  resetAccount: (input: ResetAccountInput) =>
    request<AccountDto>('/api/account/reset', { method: 'POST', body: JSON.stringify(input) }),
  trades: (kind: AccountKind) => request<TradeDto[]>(`/api/trades?account=${kind}`),
  openTrade: (input: OpenTradeInput) =>
    request<TradeDto>('/api/trades', { method: 'POST', body: JSON.stringify(input) }),
  payments: () => request<PaymentsDto>('/api/payments'),
  createDeposit: (input: CreateDepositInput) =>
    request<DepositDto>('/api/deposits', { method: 'POST', body: JSON.stringify(input) }),
  refreshDeposit: (id: string) =>
    request<DepositDto>(`/api/deposits/${id}/refresh`, { method: 'POST' }),
  createWithdrawal: (input: CreateWithdrawalInput) =>
    request<WithdrawalDto>('/api/withdrawals', { method: 'POST', body: JSON.stringify(input) }),
}

export const queryKeys = {
  instruments: ['instruments'] as const,
  candles: (symbol: string, interval: CandleInterval) => ['candles', symbol, interval] as const,
  account: (kind: AccountKind) => ['account', kind] as const,
  trades: (kind: AccountKind) => ['trades', kind] as const,
  /** Prefixos: invalidam as duas contas de uma vez. */
  accounts: ['account'] as const,
  allTrades: ['trades'] as const,
  payments: ['payments'] as const,
  fx: ['fx'] as const,
}
