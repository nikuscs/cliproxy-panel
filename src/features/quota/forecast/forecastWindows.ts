/**
 * The two windows the forecast can follow, and one rate rule for every meter.
 *
 * `weekly` is each credential's primary weekly window; `session` is the
 * 5-hour window (id `five-hour` for Claude and Codex). A meter's rate is the
 * measured one from recorded history once it covers enough time, otherwise
 * the window's average since it opened, so the provider panel and each
 * account row agree.
 */

import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { windowRatePerHour } from './burnRate';
import { measureDrain } from './forecastModel';
import type { QuotaSnapshot } from './quotaHistory';
import type { QuotaMeterReading } from './quotaMeters';

export type ForecastWindow = 'weekly' | 'session';

export const FORECAST_WINDOWS: readonly ForecastWindow[] = ['weekly', 'session'];

export const SESSION_WINDOW_ID = 'five-hour';

export const windowOfMeter = (meter: Pick<QuotaMeterReading, 'id'>): ForecastWindow =>
  meter.id === SESSION_WINDOW_ID ? 'session' : 'weekly';

/** The meter a credential contributes to a forecast window. */
export const meterForWindow = (
  meters: QuotaMeterReading[],
  window: ForecastWindow
): QuotaMeterReading | undefined =>
  window === 'weekly'
    ? meters.find((meter) => meter.primary)
    : meters.find((meter) => meter.id === SESSION_WINDOW_ID);

/** Recorded snapshots of a forecast window. */
export const snapshotsForWindow = (
  history: QuotaSnapshot[],
  window: ForecastWindow
): QuotaSnapshot[] =>
  history.filter((snapshot) =>
    window === 'weekly' ? snapshot.primary : snapshot.window === SESSION_WINDOW_ID
  );

/**
 * How a window's rate is measured. A 5-hour window is judged on its recent
 * pace (at most its own length back) and trusts 30 minutes of readings; a
 * weekly one wants half the lookback or two hours.
 */
export function windowMeasurement(
  window: ForecastWindow,
  lookbackMs: number
): { lookbackMs: number; enoughMs: number } {
  return window === 'session'
    ? { lookbackMs: Math.min(lookbackMs, 5 * HOUR_MS), enoughMs: 30 * MINUTE_MS }
    : { lookbackMs, enoughMs: Math.min(lookbackMs / 2, 2 * HOUR_MS) };
}

export interface ResolvedRate {
  /** Percent points per hour; null when the window has no usable average. */
  ratePerHour: number | null;
  source: 'history' | 'window';
  /** Recorded time behind a measured rate. */
  coveredMs: number;
  /** The window's own average since it opened (until it ran out, if it did). */
  averagePerHour: number | null;
}

/**
 * When an exhausted window hit 0: its first recorded reading at 0 in this
 * window, else now (which makes the pace a lower bound).
 */
function exhaustedAtMs(meter: QuotaMeterReading, snapshots: QuotaSnapshot[], nowMs: number) {
  const startMs = (meter.resetAtMs as number) - (meter.periodHours as number) * HOUR_MS;
  const firstEmpty = snapshots
    .filter((snapshot) => snapshot.ts >= startMs && snapshot.remaining <= 0)
    .reduce((earliest, snapshot) => Math.min(earliest, snapshot.ts), nowMs);
  return { startMs, hitMs: firstEmpty };
}

/**
 * The window average (used since the window opened, the rule openusage
 * follows), else the rate measured from this meter's own readings. Readings
 * only exist while the page is open, mostly while working, so a measured rate
 * misses the idle hours: below the average it under-warns, above it it treats
 * a burst as nonstop use. A window that ran out keeps the pace it had until it hit 0, so it still
 * counts towards the provider rate and drives its next window.
 */
export function resolveMeterRate(
  meter: QuotaMeterReading,
  snapshots: QuotaSnapshot[],
  nowMs: number,
  lookbackMs: number
): ResolvedRate {
  const rule = windowMeasurement(windowOfMeter(meter), lookbackMs);
  const exhausted =
    meter.remaining <= 0 && meter.resetAtMs !== null && meter.resetAtMs > nowMs && meter.periodHours
      ? exhaustedAtMs(meter, snapshots, nowMs)
      : null;
  const untilMs = exhausted?.hitMs ?? nowMs;
  const averagePerHour = exhausted
    ? untilMs - exhausted.startMs >= 15 * MINUTE_MS
      ? 100 / ((untilMs - exhausted.startMs) / HOUR_MS)
      : null
    : windowRatePerHour(meter, nowMs);

  const fromMs = Math.max(nowMs - rule.lookbackMs, exhausted?.startMs ?? -Infinity);
  const measured = measureDrain(snapshots, fromMs, untilMs);
  if (
    averagePerHour === null &&
    measured &&
    measured.coveredMs >= rule.enoughMs
  ) {
    return {
      ratePerHour: measured.ratePerHour,
      source: 'history',
      coveredMs: measured.coveredMs,
      averagePerHour,
    };
  }
  return {
    ratePerHour: averagePerHour,
    source: 'window',
    coveredMs: measured?.coveredMs ?? 0,
    averagePerHour,
  };
}
