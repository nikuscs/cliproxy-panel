/**
 * Instant burn rate from a single quota window, so predictions work on the
 * very first load (before the panel has recorded any history).
 *
 *   window start    = reset - window length
 *   rate            = used / elapsed                  (percent points per hour)
 *   runs out at     = now + remaining / rate          (only matters before the reset)
 *   unused at reset = max(0, remaining - rate * hours until reset)
 *
 * Pure: `nowMs` is always passed in.
 */

import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { QuotaMeterReading } from './quotaMeters';

export type BurnOutcome = 'runs_out' | 'lasts' | 'exhausted' | 'unknown';

export interface WindowBurn {
  /** Average since the window opened, percent points per hour. */
  ratePerHour: number | null;
  outcome: BurnOutcome;
  /** When the window empties at this rate (`runs_out` only). */
  runsOutAtMs: number | null;
  /** When the window refills. */
  resetAtMs: number | null;
  /** Percent still unspent when the window resets (`lasts` only). */
  unusedAtReset: number | null;
}

type BurnInput = Pick<QuotaMeterReading, 'remaining' | 'resetAtMs' | 'periodHours'>;

/** A window younger than this has no meaningful average yet. */
const MIN_ELAPSED_MS = 15 * MINUTE_MS;

const UNKNOWN: WindowBurn = {
  ratePerHour: null,
  outcome: 'unknown',
  runsOutAtMs: null,
  resetAtMs: null,
  unusedAtReset: null,
};

/** Average burn rate of a window since it opened; null without reset + length. */
export function windowRatePerHour(meter: BurnInput, nowMs: number): number | null {
  if (meter.resetAtMs === null || !meter.periodHours || meter.resetAtMs <= nowMs) return null;
  const startMs = meter.resetAtMs - meter.periodHours * HOUR_MS;
  const elapsedMs = nowMs - startMs;
  if (elapsedMs < MIN_ELAPSED_MS) return null;
  return Math.max(0, 100 - meter.remaining) / (elapsedMs / HOUR_MS);
}

/** What happens to one window if usage continues at `ratePerHour`. */
export function burnOutcome(
  remaining: number,
  resetAtMs: number,
  ratePerHour: number,
  nowMs: number
): WindowBurn {
  const base = { ratePerHour, resetAtMs };
  if (remaining <= 0) {
    return { ...base, outcome: 'exhausted', runsOutAtMs: null, unusedAtReset: 0 };
  }
  const hoursToReset = Math.max(0, (resetAtMs - nowMs) / HOUR_MS);
  if (ratePerHour > 0) {
    const runsOutAtMs = nowMs + (remaining / ratePerHour) * HOUR_MS;
    if (runsOutAtMs < resetAtMs) {
      return { ...base, outcome: 'runs_out', runsOutAtMs, unusedAtReset: 0 };
    }
  }
  return {
    ...base,
    outcome: 'lasts',
    runsOutAtMs: null,
    unusedAtReset: Math.max(0, remaining - ratePerHour * hoursToReset),
  };
}

/** At this pace the window empties before it refills: the bar to worry about. */
export const runsOutAtPace = (burn: WindowBurn): boolean => burn.outcome === 'runs_out';

/** Outcome at `ratePerHour` (a measured rate) or, by default, the window average. */
export function windowBurn(
  meter: BurnInput,
  nowMs: number,
  ratePerHour: number | null = windowRatePerHour(meter, nowMs)
): WindowBurn {
  if (meter.resetAtMs === null || meter.resetAtMs <= nowMs) return UNKNOWN;
  if (ratePerHour === null) return UNKNOWN;
  return burnOutcome(meter.remaining, meter.resetAtMs as number, ratePerHour, nowMs);
}
