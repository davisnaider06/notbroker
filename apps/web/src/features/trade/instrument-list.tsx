import { type InstrumentDto, MARKETS, type Market } from '@b-hook/contracts'
import { formatPrice } from '../../lib/format.ts'
import { useLivePrice } from '../../lib/market-stream.ts'

const MARKET_LABEL: Record<Market, string> = { CRYPTO: 'Cripto', US: 'EUA', B3: 'B3' }

interface Props {
  instruments: InstrumentDto[]
  selected: string
  onSelect: (symbol: string) => void
}

export function InstrumentList({ instruments, selected, onSelect }: Props) {
  return (
    <nav>
      {MARKETS.map((market) => (
        <section key={market}>
          <h2 className="section-title">{MARKET_LABEL[market]}</h2>
          <ul className="instrument-list">
            {instruments
              .filter((instrument) => instrument.market === market)
              .map((instrument) => (
                <InstrumentRow
                  key={instrument.symbol}
                  instrument={instrument}
                  active={instrument.symbol === selected}
                  onSelect={onSelect}
                />
              ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}

function InstrumentRow({
  instrument,
  active,
  onSelect,
}: {
  instrument: InstrumentDto
  active: boolean
  onSelect: (symbol: string) => void
}) {
  const live = useLivePrice(instrument.symbol)
  const price = live?.price ?? instrument.lastPrice

  return (
    <li>
      <button
        type="button"
        className={`instrument ${active ? 'active' : ''}`}
        onClick={() => onSelect(instrument.symbol)}
      >
        <span>
          <strong>{instrument.symbol}</strong>
          <span className="muted small">{instrument.name}</span>
        </span>
        {/* key no tick reinicia a animação de flash a cada mudança de preço */}
        <span key={live?.time} className={`price ${live?.direction ?? 'flat'}`}>
          {price == null ? '—' : formatPrice(price, instrument.currency)}
        </span>
      </button>
    </li>
  )
}
