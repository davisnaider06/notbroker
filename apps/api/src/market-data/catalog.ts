import { type Currency, MARKET_CURRENCY, type Market } from '@notbroker/contracts'

export interface Instrument {
  symbol: string
  name: string
  market: Market
  currency: Currency
  quantityDecimals: number
}

const crypto = (symbol: string, name: string, quantityDecimals: number): Instrument => ({
  symbol,
  name,
  market: 'CRYPTO',
  currency: MARKET_CURRENCY.CRYPTO,
  quantityDecimals,
})

const stock = (market: 'US' | 'B3', symbol: string, name: string): Instrument => ({
  symbol,
  name,
  market,
  currency: MARKET_CURRENCY[market],
  quantityDecimals: 0,
})

/**
 * Catálogo negociável. O servidor acompanha todos os ativos daqui o tempo inteiro, o que mantém
 * o matching de ordens limitadas funcionando mesmo sem ninguém olhando o gráfico.
 * Limite prático: a Alpaca grátis aceita 30 símbolos no WebSocket.
 */
export const CATALOG: readonly Instrument[] = [
  crypto('BTCUSDT', 'Bitcoin', 5),
  crypto('ETHUSDT', 'Ethereum', 4),
  crypto('SOLUSDT', 'Solana', 3),
  crypto('BNBUSDT', 'BNB', 3),
  crypto('XRPUSDT', 'XRP', 1),
  stock('US', 'AAPL', 'Apple'),
  stock('US', 'MSFT', 'Microsoft'),
  stock('US', 'NVDA', 'NVIDIA'),
  stock('US', 'TSLA', 'Tesla'),
  stock('US', 'AMZN', 'Amazon'),
  stock('B3', 'PETR4', 'Petrobras PN'),
  stock('B3', 'VALE3', 'Vale ON'),
  stock('B3', 'ITUB4', 'Itaú Unibanco PN'),
  stock('B3', 'BBAS3', 'Banco do Brasil ON'),
  stock('B3', 'WEGE3', 'WEG ON'),
]

const bySymbol = new Map(CATALOG.map((instrument) => [instrument.symbol, instrument]))

export function findInstrument(symbol: string): Instrument | undefined {
  return bySymbol.get(symbol)
}
