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
import { useMoneyFormatter } from '../../lib/display-currency.ts'
import { formatCountdown, priceDecimals } from '../../lib/format.ts'
import { marketStream, useLivePrice } from '../../lib/market-stream.ts'

const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86_400,
}

/** Candles visíveis ao abrir: poucos o bastante para a escala de preço mostrar o movimento. */
const VISIBLE_BARS = 60
const RIGHT_OFFSET_BARS = 3
/** Um pouco menor que o intervalo entre ticks do servidor (250 ms), para cada animação terminar. */
const ANIMATION_MS = 200
/** Metade da altura do rótulo de preço do eixo (fonte 12 px): a contagem encosta logo abaixo. */
const PRICE_LABEL_HALF_HEIGHT = 10

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
  /** Candle corrente com os valores reais; o que está desenhado pode estar no meio da animação. */
  const lastCandleRef = useRef<CandleDto | null>(null)
  const shownCloseRef = useRef<number | null>(null)
  const fittedViewRef = useRef<string | null>(null)
  const countdownRef = useRef<HTMLSpanElement>(null)
  const nextCandleRef = useRef<HTMLSpanElement>(null)
  const live = useLivePrice(instrument.symbol)
  const money = useMoneyFormatter()

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
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: css('--border'),
        rightOffset: RIGHT_OFFSET_BARS,
      },
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

  // Histórico: substitui a série inteira ao trocar ativo ou intervalo. Enquanto o novo histórico
  // não chega (ou falha), o gráfico fica vazio em vez de mostrar os candles do ativo anterior.
  const viewKey = `${instrument.symbol}:${interval}`
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    shownCloseRef.current = null
    if (!candles.data) {
      series.setData([])
      lastCandleRef.current = null
      return
    }
    const decimals = priceDecimals(candles.data.at(-1)?.close ?? 1)
    series.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals },
    })
    series.setData(candles.data.map((candle) => ({ ...candle, time: toChartTime(candle.time) })))
    lastCandleRef.current = candles.data.at(-1) ?? null

    // Enquadra só ao abrir o ativo/intervalo; um refetch não desfaz o zoom que o usuário escolheu.
    if (fittedViewRef.current !== viewKey) {
      fittedViewRef.current = viewKey
      const count = candles.data.length
      chartRef.current
        ?.timeScale()
        .setVisibleLogicalRange({ from: count - VISIBLE_BARS, to: count + RIGHT_OFFSET_BARS })
    }
  }, [candles.data, viewKey])

  // Tempo real: cada tick atualiza o candle corrente ou abre o próximo. O corpo desliza até o
  // preço novo em vez de saltar; máxima e mínima (o pavio) vão direto para o valor real.
  useEffect(() => {
    const bucket = INTERVAL_SECONDS[interval]
    let frame = 0

    const render = (close: number) => {
      const real = lastCandleRef.current
      if (!real) return
      shownCloseRef.current = close
      seriesRef.current?.update({ ...real, close, time: toChartTime(real.time) })
    }

    const animate = (from: number, to: number) => {
      cancelAnimationFrame(frame)
      const startedAt = performance.now()
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / ANIMATION_MS)
        const eased = 1 - (1 - progress) ** 3
        render(from + (to - from) * eased)
        if (progress < 1) frame = requestAnimationFrame(step)
      }
      frame = requestAnimationFrame(step)
    }

    const stopWatching = marketStream.watchPrice(instrument.symbol, () => {
      const tick = marketStream.price(instrument.symbol)
      const last = lastCandleRef.current
      if (!tick || !last || !seriesRef.current) return

      const start = Math.floor(tick.time / 1000 / bucket) * bucket
      if (start < last.time) return
      const sameCandle = start === last.time
      lastCandleRef.current = sameCandle
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

      const shown = shownCloseRef.current
      if (sameCandle && shown !== null) {
        animate(shown, tick.price)
      } else {
        cancelAnimationFrame(frame)
        // Fecha o candle anterior no valor real antes de abrir o próximo.
        if (!sameCandle) seriesRef.current.update({ ...last, time: toChartTime(last.time) })
        render(tick.price)
      }
    })

    return () => {
      cancelAnimationFrame(frame)
      stopWatching()
    }
  }, [instrument.symbol, interval])

  // Contagem regressiva até o candle fechar, colada embaixo do rótulo de último preço no eixo.
  // Atualizada por frame e direto no DOM: acompanha a animação do preço sem re-render do React.
  useEffect(() => {
    const bucketMs = INTERVAL_SECONDS[interval] * 1000
    let frame = 0
    let lastText = ''

    const update = () => {
      frame = requestAnimationFrame(update)
      const badge = countdownRef.current
      const headerTimer = nextCandleRef.current
      if (!badge || !headerTimer) return
      const candle = lastCandleRef.current
      const now = Date.now()
      // Mercado fechado: o último candle já terminou e não há o que contar.
      const isCurrent = candle !== null && candle.time * 1000 + bucketMs > now
      headerTimer.hidden = !isCurrent
      const text = formatCountdown(bucketMs - (now % bucketMs))
      if (text !== lastText) {
        badge.textContent = text
        headerTimer.textContent = `Próxima vela em: ${text}`
        lastText = text
      }

      const close = shownCloseRef.current ?? candle?.close
      const y = close === undefined ? null : seriesRef.current?.priceToCoordinate(close)
      if (!candle || close === undefined || y == null || !isCurrent) {
        badge.hidden = true
        return
      }
      badge.hidden = false
      badge.dataset.direction = close >= candle.open ? 'up' : 'down'
      badge.style.width = `${chartRef.current?.priceScale('right').width() ?? 0}px`
      badge.style.transform = `translateY(${y + PRICE_LABEL_HALF_HEIGHT}px)`
    }

    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [interval])

  return (
    <section className="chart-panel">
      <header className="chart-header">
        <div>
          <h1>{instrument.symbol}</h1>
          <span className="muted">{instrument.name}</span>
        </div>
        <strong key={live?.time} className={`last-price price ${live?.direction ?? 'flat'}`}>
          {live || instrument.lastPrice
            ? money.format(live?.price ?? instrument.lastPrice ?? 0, instrument.currency)
            : '—'}
        </strong>
        <span ref={nextCandleRef} className="next-candle muted" hidden />
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
        <span ref={countdownRef} className="candle-countdown" hidden />
      </div>
    </section>
  )
}
