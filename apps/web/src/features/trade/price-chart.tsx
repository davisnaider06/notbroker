import {
  ACCOUNT_CURRENCY,
  CANDLE_INTERVALS,
  type CandleDto,
  type CandleInterval,
  type InstrumentDto,
  MARKET_DATA_DELAY_MINUTES,
  type TradeDto,
} from '@notbroker/contracts'
import { useQuery } from '@tanstack/react-query'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ITimeScaleApi,
  LineStyle,
  type Logical,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import { ApiError, api, queryKeys } from '../../lib/api.ts'
import { useMoneyFormatter } from '../../lib/display-currency.ts'
import { formatCountdown, formatMoney, formatNumber, priceDecimals } from '../../lib/format.ts'
import { marketStream, useLivePrice } from '../../lib/market-stream.ts'
import { serverNow } from '../../lib/server-clock.ts'

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
/** Teto da espera entre tentativas de buscar o histórico. */
const MAX_RETRY_DELAY_MS = 10_000
/** Rótulos das linhas de expiração ficam empilhados com esse passo, o mais próximo em cima. */
const EXPIRY_LABEL_STEP = 20

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
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  /** Velas desenhadas: as marcas só podem ir em vela que existe, e a posição no tempo vem do índice. */
  const barTimesRef = useRef(new Set<number>())
  const barCountRef = useRef(0)
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
    // Provedor fora do ar passa: o gráfico continua tentando em vez de parar num erro.
    // 4xx é pedido errado e não melhora repetindo.
    retry: (_count, error) => !(error instanceof ApiError && error.status < 500),
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS),
  })

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: css('--surface') },
        textColor: css('--text-muted'),
        fontFamily: css('--font-mono'),
        // A atribuição exigida pela licença fica no link da barra lateral (e no NOTICE).
        attributionLogo: false,
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
    markersRef.current = createSeriesMarkers(seriesRef.current, [])
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      markersRef.current = null
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
      barTimesRef.current = new Set()
      barCountRef.current = 0
      return
    }
    const decimals = priceDecimals(candles.data.at(-1)?.close ?? 1)
    series.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals },
    })
    series.setData(candles.data.map((candle) => ({ ...candle, time: toChartTime(candle.time) })))
    lastCandleRef.current = candles.data.at(-1) ?? null
    barTimesRef.current = new Set(candles.data.map((candle) => candle.time))
    barCountRef.current = candles.data.length

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
      // Máxima/mínima vêm de todos os negócios da janela, não só do último: picos rápidos aparecem
      // no pavio. O servidor nunca junta numa janela negócios de minutos diferentes.
      lastCandleRef.current = sameCandle
        ? {
            ...last,
            high: Math.max(last.high, tick.high),
            low: Math.min(last.low, tick.low),
            close: tick.price,
          }
        : {
            time: start,
            open: tick.open,
            high: tick.high,
            low: tick.low,
            close: tick.price,
            volume: 0,
          }

      const shown = shownCloseRef.current
      if (sameCandle && shown !== null) {
        animate(shown, tick.price)
      } else {
        cancelAnimationFrame(frame)
        // Fecha o candle anterior no valor real antes de abrir o próximo.
        if (!sameCandle) {
          seriesRef.current.update({ ...last, time: toChartTime(last.time) })
          barTimesRef.current.add(start)
          barCountRef.current += 1
        }
        render(tick.price)
      }
    })

    return () => {
      cancelAnimationFrame(frame)
      stopWatching()
    }
  }, [instrument.symbol, interval])

  const trades = useQuery({ queryKey: queryKeys.trades, queryFn: api.trades })
  const openHere = (trades.data ?? []).filter(
    (trade) => trade.status === 'open' && trade.symbol === instrument.symbol,
  )

  // Operações abertas neste ativo: linha tracejada no preço de entrada, na cor da direção.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    const lines = (trades.data ?? [])
      .filter((trade) => trade.status === 'open' && trade.symbol === instrument.symbol)
      .map((trade) =>
        series.createPriceLine({
          price: Number(trade.entryPrice),
          color: css(trade.direction === 'buy' ? '--up' : '--down'),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: `${trade.direction === 'buy' ? '▲' : '▼'} ${formatMoney(trade.stake, 'BRL')}`,
        }),
      )
    return () => {
      for (const line of lines) series.removePriceLine(line)
    }
  }, [trades.data, instrument.symbol])

  // Marcas na vela de entrada (seta na direção) e na de saída (resultado). Recalculadas quando
  // muda o histórico de velas ou de operações; vela que não está no gráfico fica sem marca.
  useEffect(() => {
    const bucket = INTERVAL_SECONDS[interval]
    const bucketOf = (ms: number) => Math.floor(ms / 1000 / bucket) * bucket
    // barTimesRef acabou de ser preenchido com estas velas pelo efeito do histórico.
    if (!candles.data) {
      markersRef.current?.setMarkers([])
      return
    }
    const bars = barTimesRef.current
    const markers: SeriesMarker<Time>[] = []
    for (const trade of trades.data ?? []) {
      if (trade.symbol !== instrument.symbol) continue
      const buy = trade.direction === 'buy'
      const entry = bucketOf(Date.parse(trade.openedAt))
      if (bars.has(entry)) {
        markers.push({
          time: toChartTime(entry),
          position: buy ? 'belowBar' : 'aboveBar',
          shape: buy ? 'arrowUp' : 'arrowDown',
          color: css(buy ? '--up' : '--down'),
        })
      }
      if (trade.status === 'open') continue
      // A operação vence no fechamento da vela: a marca vai na vela que terminou ali.
      const exit = bucketOf(Date.parse(trade.expiresAt) - 1)
      if (!bars.has(exit)) continue
      // Texto curto: velas vizinhas com resultado não podem encavalar; a cor já diz win ou loss.
      const net = Number(trade.payout ?? 0) - Number(trade.stake)
      const text =
        trade.status === 'won'
          ? `+${formatNumber(net, 2, 2)}`
          : trade.status === 'lost'
            ? `−${formatNumber(trade.stake, 2, 2)}`
            : trade.status === 'draw'
              ? '='
              : 'estorno'
      markers.push({
        time: toChartTime(exit),
        position: buy ? 'aboveBar' : 'belowBar',
        shape: 'circle',
        color: css(
          trade.status === 'won' ? '--up' : trade.status === 'lost' ? '--down' : '--text-muted',
        ),
        text,
      })
    }
    markers.sort((a, b) => Number(a.time) - Number(b.time))
    // Texto de velas vizinhas no mesmo lado encavala: a segunda fica só com o círculo colorido.
    const lastTextAt = new Map<string, number>()
    for (const marker of markers) {
      if (!marker.text) continue
      const previous = lastTextAt.get(marker.position)
      if (previous !== undefined && Number(marker.time) - previous <= bucket) {
        delete marker.text
      } else {
        lastTextAt.set(marker.position, Number(marker.time))
      }
    }
    markersRef.current?.setMarkers(markers)
  }, [trades.data, candles.data, instrument.symbol, interval])

  // Linha vertical no instante em que cada operação aberta vence, com o tempo que falta. A posição
  // sai do índice da vela (vale também à direita da última vela) e é atualizada por frame.
  useEffect(() => {
    const bucket = INTERVAL_SECONDS[interval]
    let frame = 0

    const update = () => {
      frame = requestAnimationFrame(update)
      const container = containerRef.current
      const chart = chartRef.current
      const last = lastCandleRef.current
      if (!container || !chart) return
      const lines = container.querySelectorAll<HTMLElement>('.expiry-line')
      if (lines.length === 0) return
      const timeScale = chart.timeScale()
      const paneWidth = timeScale.width()
      const paneHeight = container.clientHeight - timeScale.height()
      const now = serverNow()
      for (const line of lines) {
        const expiresAt = Number(line.dataset.expires)
        // A vela i ocupa [início, início + intervalo) centrada em i: o fim dela fica em i + 0,5.
        const x = last
          ? coordinateAt(
              timeScale,
              barCountRef.current - 1 + (expiresAt / 1000 - last.time) / bucket - 0.5,
            )
          : null
        if (x === null || x < 0 || x > paneWidth) {
          line.hidden = true
          continue
        }
        line.hidden = false
        line.style.height = `${paneHeight}px`
        line.style.transform = `translateX(${Math.round(x)}px)`
        const countdown = line.querySelector('.expiry-countdown')
        const text = formatCountdown(expiresAt - now)
        if (countdown && countdown.textContent !== text) countdown.textContent = text
      }
    }

    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [interval])

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
      const now = serverNow()
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
          {MARKET_DATA_DELAY_MINUTES[instrument.market] > 0 && (
            <span className="delay-badge">
              cotação com {MARKET_DATA_DELAY_MINUTES[instrument.market]} min de atraso
            </span>
          )}
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
        {!candles.data && (
          <p className={`chart-overlay ${candles.isError ? 'error' : 'muted'}`}>
            {candles.isError
              ? candles.error.message
              : candles.failureCount > 0
                ? 'O provedor de cotações não respondeu. Tentando de novo…'
                : 'Carregando histórico…'}
          </p>
        )}
        <span ref={countdownRef} className="candle-countdown" hidden />
        {byExpiry(openHere).map((trade, stack) => (
          <div
            key={trade.id}
            className="expiry-line"
            data-direction={trade.direction === 'buy' ? 'up' : 'down'}
            data-expires={Date.parse(trade.expiresAt)}
            hidden
          >
            <span className="expiry-label" style={{ top: 8 + stack * EXPIRY_LABEL_STEP }}>
              {trade.direction === 'buy' ? '▲' : '▼'} {formatMoney(trade.stake, ACCOUNT_CURRENCY)} ·{' '}
              <span className="expiry-countdown" />
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * Ordem de vencimento: cada rótulo ganha a sua altura na pilha. Linhas a poucas velas de distância
 * teriam rótulos encavalados se ficassem todos na mesma altura.
 */
function byExpiry(trades: TradeDto[]): TradeDto[] {
  return trades.toSorted((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
}

/** logicalToCoordinate só aceita índice inteiro (fracionário vira 0): interpola entre os vizinhos. */
function coordinateAt(timeScale: ITimeScaleApi<Time>, logical: number): number | null {
  const base = Math.floor(logical)
  const left = timeScale.logicalToCoordinate(base as Logical)
  const right = timeScale.logicalToCoordinate((base + 1) as Logical)
  if (left === null || right === null) return null
  return left + (right - left) * (logical - base)
}
