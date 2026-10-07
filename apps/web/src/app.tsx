import { AuthScreen } from './features/auth/auth-screen.tsx'
import { TradeScreen } from './features/trade/trade-screen.tsx'
import { authClient } from './lib/auth-client.ts'

export function App() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) return <div className="splash">B-Hook</div>
  if (!session) return <AuthScreen />
  return <TradeScreen user={session.user} />
}
