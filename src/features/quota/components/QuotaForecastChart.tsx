/**
 * Plain-SVG area chart for the quota forecast: solid recorded history, a dotted
 * "Now" marker, a dashed projection and a hover readout. Gaps in history are
 * separate segments and are never joined.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type { ChartPoint } from '../forecast/forecastModel';
import { formatOutlookTime, resolveLocale } from '../display';
import styles from './QuotaForecast.module.scss';

const PAD = { top: 10, right: 8, bottom: 22, left: 44 };
const TICK_STEPS = [1, 3, 6, 12, 24, 48].map((hours) => hours * HOUR_MS);
const MAX_X_TICKS = 6;

/** A dashed line where accounts hit their limit; `warn` (yellow) while others still cover. */
export interface ChartMarker {
  atMs: number;
  label: string;
  tone: 'warn' | 'out';
}

export interface QuotaForecastChartProps {
  height: number;
  startMs: number;
  endMs: number;
  nowMs: number;
  yMax: number;
  history: ChartPoint[][];
  projection: ChartPoint[];
  accent: string;
  label: string;
  formatValue: (value: number) => string;
  /** Fewer gridlines for short charts. */
  compact?: boolean;
  /**
   * A flat reference value (the window-average drain), drawn as a muted
   * dashed line across the chart with its label, never as measured data.
   */
  reference?: { value: number; label: string } | null;
  /** Short inline note over an empty plot ("Measuring… 3 readings so far"). */
  note?: string | null;
  /** When accounts hit their limit at this pace: dashed lines with a label. */
  markers?: ChartMarker[];
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * Local-midnight-aligned ticks, at most MAX_X_TICKS across the span. Steps by
 * wall-clock hours (not fixed milliseconds) so a DST change keeps ticks on the hour.
 */
function timeTicks(startMs: number, endMs: number): { ms: number; step: number }[] {
  const step =
    TICK_STEPS.find((candidate) => (endMs - startMs) / candidate <= MAX_X_TICKS) ?? 2 * DAY_MS;
  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  const ticks: { ms: number; step: number }[] = [];
  while (cursor.getTime() <= endMs) {
    if (cursor.getTime() >= startMs) ticks.push({ ms: cursor.getTime(), step });
    cursor.setHours(cursor.getHours() + step / HOUR_MS);
  }
  return ticks;
}

/** Last point at or before `t` in a sorted series (the step value shown at `t`). */
function valueAt(points: ChartPoint[], t: number): number | null {
  if (points.length === 0 || t < points[0].t || t > points[points.length - 1].t) return null;
  let value = points[0].v;
  for (const point of points) {
    if (point.t > t) break;
    value = point.v;
  }
  return value;
}

export function QuotaForecastChart(props: QuotaForecastChartProps) {
  const { height, startMs, endMs, nowMs, yMax, history, projection, accent, label, formatValue } =
    props;
  const compact = props.compact === true;
  const reference = props.reference ?? null;
  const note = props.note ?? null;
  const markers = (props.markers ?? []).filter((marker) => marker.atMs <= endMs);
  const { i18n, t } = useTranslation();
  const gradientId = useId();
  const { ref, width } = useWidth();
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const plotWidth = Math.max(0, width - PAD.left - PAD.right);
  const plotHeight = height - PAD.top - PAD.bottom;
  const x = (ms: number) => PAD.left + ((ms - startMs) / (endMs - startMs)) * plotWidth;
  const y = (value: number) => PAD.top + plotHeight - (Math.min(value, yMax) / yMax) * plotHeight;
  const baseline = y(0);

  const clip = (points: ChartPoint[]) =>
    points.filter((point) => point.t >= startMs && point.t <= endMs);
  const linePath = (points: ChartPoint[]) =>
    points.map((point, index) => `${index ? 'L' : 'M'}${x(point.t)},${y(point.v)}`).join('');
  const areaPath = (points: ChartPoint[]) =>
    points.length < 2
      ? ''
      : `${linePath(points)}L${x(points[points.length - 1].t)},${baseline}L${x(points[0].t)},${baseline}Z`;

  const historySegments = history.map(clip).filter((segment) => segment.length > 0);
  const projected = clip(projection);
  const yTicks = (compact ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map(
    (fraction) => fraction * yMax
  );
  const nowX = x(nowMs);
  // A past-only chart (drain) ends at now: keep its label and note inside the plot.
  const nowAtEdge = nowMs >= endMs;

  const tickLabel = (ms: number, step: number) =>
    new Date(ms).toLocaleString(
      resolveLocale(i18n.language),
      step >= DAY_MS ? { month: 'short', day: 'numeric' } : { hour: 'numeric' }
    );

  const hoverValue =
    hoverMs === null
      ? null
      : hoverMs <= nowMs
        ? (historySegments.map((segment) => valueAt(segment, hoverMs)).find((v) => v !== null) ??
          null)
        : valueAt(projected, hoverMs);

  const handleMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    if (px < PAD.left || px > width - PAD.right) return setHoverMs(null);
    setHoverMs(startMs + ((px - PAD.left) / plotWidth) * (endMs - startMs));
  };

  const readoutLeft = hoverMs === null ? 0 : x(hoverMs);
  const readoutFlip = readoutLeft > width - 150;

  return (
    <div
      ref={ref}
      className={styles.chart}
      style={{ '--forecast-accent': accent, height } as CSSProperties}
    >
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverMs(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.26} />
              <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          {yTicks.map((value, index) => (
            <g key={index}>
              <line
                className={index === 0 ? styles.baseLine : styles.gridLine}
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(value)}
                y2={y(value)}
              />
              <text
                className={styles.axisLabel}
                x={PAD.left - 8}
                y={y(value)}
                textAnchor="end"
                dy="0.35em"
              >
                {formatValue(value)}
              </text>
            </g>
          ))}
          {timeTicks(startMs, endMs).map(({ ms, step }) => (
            <text
              key={ms}
              className={styles.axisLabel}
              x={x(ms)}
              y={height - 5}
              textAnchor="middle"
            >
              {tickLabel(ms, step)}
            </text>
          ))}

          {historySegments.map((segment) =>
            // A lone reading (one measured bucket, or one point between gaps)
            // has no line to draw: show it as a dot instead of nothing.
            segment.length === 1 ? (
              <circle
                key={segment[0].t}
                cx={x(segment[0].t)}
                cy={y(segment[0].v)}
                r={3}
                fill={accent}
              />
            ) : (
              <g key={segment[0].t}>
                <path d={areaPath(segment)} fill={`url(#${gradientId})`} />
                <path d={linePath(segment)} className={styles.historyLine} />
              </g>
            )
          )}
          {projected.length > 1 && (
            <>
              <path d={areaPath(projected)} fill={`url(#${gradientId})`} opacity={0.65} />
              <path d={linePath(projected)} className={styles.projectionLine} />
            </>
          )}

          {reference && reference.value > 0 && (
            <g>
              <line
                className={styles.referenceLine}
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(reference.value)}
                y2={y(reference.value)}
              />
              <text
                className={styles.referenceLabel}
                x={width - PAD.right - 4}
                y={y(reference.value) - 5}
                textAnchor="end"
              >
                {reference.label}
              </text>
            </g>
          )}

          {/* Bottom of the plot, clear of the reference line in the upper part. */}
          {note && (
            <text
              className={styles.chartNote}
              x={nowAtEdge ? PAD.left + 8 : nowX + 6}
              y={baseline - 8}
            >
              {note}
            </text>
          )}

          {markers.map((marker) => (
            <g
              key={marker.label}
              className={marker.tone === 'warn' ? styles.markerWarn : undefined}
            >
              <line
                className={styles.limitLine}
                x1={x(marker.atMs)}
                x2={x(marker.atMs)}
                y1={PAD.top}
                y2={baseline}
              />
              <text className={styles.limitLabel} x={x(marker.atMs) + 6} y={PAD.top + 10}>
                {marker.label}
              </text>
            </g>
          ))}

          <line className={styles.nowLine} x1={nowX} x2={nowX} y1={PAD.top} y2={baseline} />
          <text
            className={styles.nowLabel}
            x={nowAtEdge ? nowX - 6 : nowX + 6}
            y={PAD.top + 10}
            textAnchor={nowAtEdge ? 'end' : 'start'}
          >
            {t('quota_management.forecast_now')}
          </text>

          {hoverMs !== null && hoverValue !== null && (
            <g className={styles.hover} pointerEvents="none">
              <line x1={readoutLeft} x2={readoutLeft} y1={PAD.top} y2={baseline} />
              <circle cx={readoutLeft} cy={y(hoverValue)} r={3.5} fill={accent} />
            </g>
          )}
        </svg>
      )}
      {hoverMs !== null && hoverValue !== null && (
        <div
          className={styles.readout}
          style={{
            left: readoutFlip ? undefined : readoutLeft + 10,
            right: readoutFlip ? width - readoutLeft + 10 : undefined,
          }}
        >
          <span className={styles.readoutValue}>{formatValue(hoverValue)}</span>
          <span>{formatOutlookTime(hoverMs, i18n.language)}</span>
        </div>
      )}
    </div>
  );
}
