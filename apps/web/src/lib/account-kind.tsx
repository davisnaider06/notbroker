import type { AccountKind } from '@notbroker/contracts'
import { createContext, type ReactNode, useContext, useState } from 'react'

const STORAGE_KEY = 'notbroker:account'

/** Conta que a tela está operando. Guardada no navegador: recarregar não volta para a demo. */
const AccountKindContext = createContext<{
  kind: AccountKind
  setKind: (kind: AccountKind) => void
}>({ kind: 'demo', setKind: () => {} })

function readStored(): AccountKind {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'real' ? 'real' : 'demo'
  } catch {
    return 'demo'
  }
}

export function AccountKindProvider({ children }: { children: ReactNode }) {
  const [kind, setKindState] = useState<AccountKind>(readStored)
  const setKind = (next: AccountKind) => {
    setKindState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Sem storage (aba anônima bloqueada): a escolha vale só nesta aba.
    }
  }
  return <AccountKindContext value={{ kind, setKind }}>{children}</AccountKindContext>
}

export function useAccountKind() {
  return useContext(AccountKindContext)
}
