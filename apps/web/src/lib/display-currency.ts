import {
  type Currency,
  convertCurrency,
  DISPLAY_CURRENCIES,
  type DisplayCurrency,
} from '@b-hook/contracts'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'
import { api, queryKeys } from './api.ts'
import { formatPrice } from './format.ts'

/** "ORIGINAL" mostra cada valor na moeda em que o ativo é negociado. */
export type DisplayChoice = 'ORIGINAL' | DisplayCurrency

const STORAGE_KEY = 'b-hook:display-currency'
const listeners = new Set<() => void>()

function readStored(): DisplayChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return DISPLAY_CURRENCIES.find((currency) => currency === stored) ?? 'ORIGINAL'
  } catch {
    return 'ORIGINAL'
  }
}

let current: DisplayChoice = readStored()

export function setDisplayCurrency(choice: DisplayChoice): void {
  current = choice
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Sem storage (aba anônima, bloqueio): a escolha vale só até recarregar.
  }
  for (const listener of listeners) listener()
}

export function useDisplayCurrency(): DisplayChoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}

/**
 * Formata um valor na moeda escolhida pelo usuário, convertendo pelo câmbio do servidor.
 * Enquanto o câmbio não chega, mostra na moeda original em vez de um número errado.
 */
export function useMoneyFormatter() {
  const display = useDisplayCurrency()
  const fx = useQuery({
    queryKey: queryKeys.fx,
    queryFn: api.fx,
    refetchInterval: 60_000,
    enabled: display !== 'ORIGINAL',
  })
  const rates = fx.data

  const format = useCallback(
    (value: string | number, currency: Currency, decimals?: number): string => {
      if (display === 'ORIGINAL' || !rates) return formatPrice(value, currency, decimals)
      return formatPrice(
        convertCurrency(Number(value), currency, display, rates),
        display,
        decimals,
      )
    },
    [display, rates],
  )

  return { display, format }
}
