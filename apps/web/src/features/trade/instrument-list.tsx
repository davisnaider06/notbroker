import { type InstrumentDto, MARKETS, type Market } from '@b-hook/contracts'
import {
  type DisplayChoice,
  setDisplayCurrency,
  useMoneyFormatter,
} from '../../lib/display-currency.ts'
import { useLivePrice } from '../../lib/market-stream.ts'

const DISPLAY_OPTIONS: { value: DisplayChoice; label: string }[] = [
  { value: 'ORIGINAL', label: 'Orig.' },
  { value: 'USD', label: 'USD' },
  { value: 'EUR', label: 'EUR' },
  { value: 'GBP', label: 'GBP' },
  { value: 'BRL', label: 'BRL' },
]

const MARKET_LABEL: Record<Market, string> = { CRYPTO: 'Cripto', US: 'EUA', B3: 'B3' }

interface Props {
  instruments: InstrumentDto[]
  selected: string
  onSelect: (symbol: string) => void
}

export function InstrumentList({ instruments, selected, onSelect }: Props) {
  return (
    <nav>
      <CurrencySwitch />
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
  const money = useMoneyFormatter()

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
          {price == null ? '—' : money.format(price, instrument.currency)}
        </span>
      </button>
    </li>
  )
}

/** Só muda a exibição dos preços; ordens continuam na moeda em que o ativo é negociado. */
function CurrencySwitch() {
  const { display } = useMoneyFormatter()
  return (
    <div className="currency-switch">
      <span className="muted small">Exibir preços em</span>
      <div className="segmented wide">
        {DISPLAY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === display ? 'active' : ''}
            title={option.value === 'ORIGINAL' ? 'Moeda em que cada ativo é negociado' : undefined}
            onClick={() => setDisplayCurrency(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
