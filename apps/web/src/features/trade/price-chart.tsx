import {
  CANDLE_INTERVALS,
  type CandleDto,
  type CandleInterval,
  type InstrumentDto,
} from '@b-hook/contracts'
import { useQuery } from '@tanstack/react-query'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import { api, queryKeys } from '../../lib/api.ts'
import { formatPrice, priceDecimals } from '../../lib/format.ts'
import { marketStream, useLivePrice } from '../../lib/market-stream.ts'

const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86_400,
}

/** O lightweight-charts desenha tudo em UTC; deslocamos para o fuso local do navegador. */
const TZ_OFFSET = -new Date().getTimezoneOffset() * 60
const toChartTime = (seconds: number) => (seconds + TZ_OFFSET) as UTCTimestamp

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export function PriceChart({ instrument }: { instrument: InstrumentDto }) {
  const [interval, setCandleInterval] = useState<CandleInterval>('1m')
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const lastCandleRef = useRef<CandleDto | null>(null)
  const live = useLivePrice(instrument.symbol)

  const candles = useQuery({
    queryKey: queryKeys.candles(instrument.symbol, interval),
    queryFn: () => api.candles(instrument.symbol, interval),
  })

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: css('--surface') },
        textColor: css('--text-muted'),
        fontFamily: css('--font-mono'),
      },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: css('--border') },
      rightPriceScale: { borderColor: css('--border') },
    })
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: css('--up'),
      downColor: css('--down'),
      wickUpColor: css('--up'),
      wickDownColor: css('--down'),
      borderVisible: false,
    })
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  // Histórico: substitui a série inteira ao trocar ativo ou intervalo.
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !candles.data) return
    const decimals = priceDecimals(candles.data.at(-1)?.close ?? 1)
    series.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals },
    })
    series.setData(candles.data.map((candle) => ({ ...candle, time: toChartTime(candle.time) })))
    lastCandleRef.current = candles.data.at(-1) ?? null
    chartRef.current?.timeScale().scrollToRealTime()
  }, [candles.data])

  // Tempo real: cada tick atualiza o candle corrente ou abre o próximo.
  useEffect(() => {
    const bucket = INTERVAL_SECONDS[interval]
    return marketStream.watchPrice(instrument.symbol, () => {
      const tick = marketStream.price(instrument.symbol)
      const last = lastCandleRef.current
      const series = seriesRef.current
      if (!tick || !last || !series) return

      const start = Math.floor(tick.time / 1000 / bucket) * bucket
      if (start < last.time) return
      const next: CandleDto =
        start === last.time
          ? {
              ...last,
              high: Math.max(last.high, tick.price),
              low: Math.min(last.low, tick.price),
              close: tick.price,
            }
          : {
              time: start,
              open: tick.price,
              high: tick.price,
              low: tick.price,
              close: tick.price,
              volume: 0,
            }
      lastCandleRef.current = next
      series.update({ ...next, time: toChartTime(next.time) })
    })
  }, [instrument.symbol, interval])

  return (
    <section className="chart-panel">
      <header className="chart-header">
        <div>
          <h1>{instrument.symbol}</h1>
          <span className="muted">{instrument.name}</span>
        </div>
        <strong key={live?.time} className={`last-price price ${live?.direction ?? 'flat'}`}>
          {live || instrument.lastPrice
            ? formatPrice(live?.price ?? instrument.lastPrice ?? 0, instrument.currency)
            : '—'}
        </strong>
        <div className="segmented">
          {CANDLE_INTERVALS.map((option) => (
            <button
              key={option}
              type="button"
              className={option === interval ? 'active' : ''}
              onClick={() => setCandleInterval(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </header>
      <div className="chart" ref={containerRef}>
        {candles.isError && <p className="chart-overlay error">{candles.error.message}</p>}
      </div>
    </section>
  )
}
