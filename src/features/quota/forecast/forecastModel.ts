/**
 * Provider-wide quota forecast: recorded history, drain rate and a projection.
 *
 * Works on the primary weekly window of each credential. Capacity is N x 100%.
 * The drain rate comes from recorded history when there is enough of it, and
 * from each window's own average otherwise, so it works on the first load. The
 * projection refills each credential at its known reset, which gives the
 * sawtooth. Pure: `nowMs` is always passed in.
 */

import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { burnOutcome } from './burnRate';
import type { QuotaSnapshot } from './quotaHistory';

/** Two readings further apart than this are a gap, never interpolated. */
export const HISTORY_GAP_MS = 3 * HOUR_MS;

const PROJECTION_STEP_MS = 10 * MINUTE_MS;
/** Credentials resetting this close together count as one reset event. */
const RESET_GROUP_MS = MINUTE_MS;

export interface ChartPoint {
  t: number;
  v: number;
}

export interface LiveReading {
  credentialId: string;
  remaining: number;
  resetAtMs: number | null;
  periodHours: number | null;
  /**
   * Rate used for this account: the faster of its window average and its
   * measured rate. A window that ran out keeps the pace it had until it hit 0.
   */
  ratePerHour: number | null;
  /** The window's own average since it opened (the dotted reference line). */
  averagePerHour: number | null;
}

/** Where the provider drain rate comes from. */
export type DrainSource = 'history' | 'window';

export interface ProviderDrain {
  /** Rate used for the projection, percent points per hour. */
  ratePerHour: number;
  source: DrainSource;
  /** Recorded history inside the lookback that backs a measured rate. */
  coveredMs: number;
  /** Sum of each window's average since it opened (until it ran out): the reference. */
  windowAverage: number;
}

export interface ResetEvent {
  atMs: number;
  /** Capacity given back, in percent points. */
  gain: number;
}

export interface QuotaForecast {
  capacity: number;
  remaining: number;
  /** Percent points per hour across the provider, with where it comes from. */
  drain: ProviderDrain;
  history: ChartPoint[][];
  projection: ChartPoint[];
  nextReset: ResetEvent | null;
  /** When the whole provider hits 0% inside the range, if it does. */
  allOutAtMs: number | null;
  /** First account to run out before its own reset, at its window rate. */
  firstRunsOutAtMs: number | null;
  /** Accounts at 0% right now, and when the first of them refills. */
  outNow: { count: number; backAtMs: number | null };
  /** Percent still unspent across accounts when their windows reset. */
  unusedAtResets: number;
  /** Per-account detail behind `unusedAtResets`, soonest reset first. */
  unusedByAccount: { credentialId: string; unused: number; resetAtMs: number }[];
  /** Distinct recorded readings in the loaded history. */
  readings: number;
}

export interface ForecastInput {
  live: LiveReading[];
  history: QuotaSnapshot[];
  nowMs: number;
  /** Forward horizon of the projection. */
  rangeMs: number;
  /** Window the drain rate is measured over. */
  lookbackMs: number;
  /** Recorded coverage needed before the measured rate replaces the average. */
  enoughMs: number;
}

const byCredential = (history: QuotaSnapshot[]) => {
  const groups = new Map<string, QuotaSnapshot[]>();
  history.forEach((snapshot) => {
    const group = groups.get(snapshot.credentialId) ?? [];
    group.push(snapshot);
    groups.set(snapshot.credentialId, group);
  });
  groups.forEach((group) => group.sort((a, b) => a.ts - b.ts));
  return groups;
};

/** Value a snapshot implies at `t`: a passed reset means the window refilled. */
const valueAt = (snapshot: QuotaSnapshot, t: number) =>
  snapshot.resetAtMs !== null && snapshot.resetAtMs <= t ? 100 : snapshot.remaining;

/**
 * Sum of every credential's latest fresh reading at each recorded instant.
 * Instants are bucketed to the minute; a silence longer than the gap splits
 * the line into separate segments.
 */
export function aggregateHistory(history: QuotaSnapshot[]): ChartPoint[][] {
  const groups = byCredential(history);
  const instants = Array.from(
    new Set(history.map((snapshot) => Math.round(snapshot.ts / MINUTE_MS) * MINUTE_MS))
  ).sort((a, b) => a - b);
  const cursors = new Map<string, number>();

  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  let previousT: number | null = null;

  instants.forEach((t) => {
    let sum = 0;
    let fresh = 0;
    groups.forEach((group, credentialId) => {
      let index = cursors.get(credentialId) ?? -1;
      while (index + 1 < group.length && group[index + 1].ts <= t + MINUTE_MS / 2) index += 1;
      cursors.set(credentialId, index);
      const snapshot = group[index];
      if (!snapshot || t - snapshot.ts > HISTORY_GAP_MS) return;
      sum += valueAt(snapshot, t);
      fresh += 1;
    });
    if (fresh === 0) return;
    if (previousT !== null && t - previousT > HISTORY_GAP_MS && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push({ t, v: sum });
    previousT = t;
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Two readings belong to one run: close enough in time and no reset between. */
const sameRun = (a: QuotaSnapshot, b: QuotaSnapshot) =>
  b.ts - a.ts <= HISTORY_GAP_MS && (a.resetAtMs === null || a.resetAtMs > b.ts);

interface DrainMeasurement {
  ratePerHour: number;
  coveredMs: number;
}

/**
 * Consumption in [fromMs, toMs] from recorded history.
 *
 * Usage values are coarse (Anthropic reports whole percent), so most
 * consecutive readings are equal and the drop shows up as a rare 1% step.
 * Each credential's readings are split into gap-free runs (no silence over
 * HISTORY_GAP_MS, no reset); a run contributes first - last over its span, so
 * a period with any drop never reads as 0. The rate is the total consumed over
 * the union of the runs' spans. Null when less than `minCoveredMs` is covered.
 * Expects one window per credential (the caller filters by window).
 */
export function measureDrain(
  history: QuotaSnapshot[],
  fromMs: number,
  toMs: number,
  minCoveredMs = 30 * MINUTE_MS
): DrainMeasurement | null {
  let consumed = 0;
  const spans: [number, number][] = [];

  byCredential(history).forEach((group) => {
    // The last reading before `fromMs` anchors a run that started earlier.
    const firstInside = group.findIndex((snapshot) => snapshot.ts >= fromMs);
    if (firstInside === -1) return;
    const inRange = group
      .slice(Math.max(0, firstInside - 1))
      .filter((snapshot) => snapshot.ts <= toMs);

    let runStart = 0;
    for (let index = 1; index <= inRange.length; index += 1) {
      const ended = index === inRange.length || !sameRun(inRange[index - 1], inRange[index]);
      if (!ended) continue;
      const first = inRange[runStart];
      const last = inRange[index - 1];
      const spanStart = Math.max(first.ts, fromMs);
      const spanEnd = Math.min(last.ts, toMs);
      if (spanEnd > spanStart) {
        consumed += Math.max(0, first.remaining - last.remaining);
        spans.push([spanStart, spanEnd]);
      }
      runStart = index;
    }
  });

  spans.sort((a, b) => a[0] - b[0]);
  let coveredMs = 0;
  let end = -Infinity;
  spans.forEach(([start, stop]) => {
    if (stop <= end) return;
    coveredMs += stop - Math.max(start, end);
    end = stop;
  });
  if (coveredMs < minCoveredMs) return null;
  return { ratePerHour: consumed / (coveredMs / HOUR_MS), coveredMs };
}

/** Drain buckets across the shown span: enough for a line, not so many it turns to noise. */
const DRAIN_BUCKETS = 36;
const MIN_DRAIN_BUCKET_MS = 10 * MINUTE_MS;
/** Each point averages this many buckets back, so 1% steps read as a rate, not spikes. */
const DRAIN_SMOOTHING_BUCKETS = 3;
/** The drain chart spans at least this much, even with a few minutes of readings. */
const MIN_DRAIN_SPAN_MS = HOUR_MS;

export interface DrainSeries {
  /** Left edge of the chart; the right edge is now. */
  startMs: number;
  segments: ChartPoint[][];
}

/**
 * Measured drain over the past, for the "Drain rate" chart. It covers the
 * recorded readings (at most `rangeMs` back), sampled every span/36 (at least
 * 10 min); each point is the trailing average over three samples. Points join
 * inside a run of readings; a silence over HISTORY_GAP_MS starts a new line.
 */
export function drainSeries(history: QuotaSnapshot[], nowMs: number, rangeMs: number): DrainSeries {
  const earliestMs = history.reduce((earliest, snapshot) => Math.min(earliest, snapshot.ts), nowMs);
  const startMs = Math.max(nowMs - rangeMs, Math.min(earliestMs, nowMs - MIN_DRAIN_SPAN_MS));
  const bucketMs = Math.max(MIN_DRAIN_BUCKET_MS, (nowMs - startMs) / DRAIN_BUCKETS);
  const windowMs = bucketMs * DRAIN_SMOOTHING_BUCKETS;

  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (let t = startMs + bucketMs; t < nowMs + bucketMs; t += bucketMs) {
    const at = Math.min(t, nowMs);
    const measured = measureDrain(history, at - windowMs, at, windowMs / 6);
    if (measured === null) continue;
    const last = current[current.length - 1];
    if (last && at - last.t > HISTORY_GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push({ t: at, v: measured.ratePerHour });
  }
  if (current.length > 0) segments.push(current);
  return { startMs, segments };
}

/**
 * Current provider drain: the sum of each account's rate, or the rate measured
 * from recorded history when that covers enough of the lookback and is faster.
 * An account that ran out counts at the pace it had until it hit 0: it is the
 * provider's usage pace, not just what is draining this minute.
 */
export function currentDrain(
  live: LiveReading[],
  history: QuotaSnapshot[],
  nowMs: number,
  lookbackMs: number,
  enoughMs: number
): ProviderDrain {
  const measured = measureDrain(history, nowMs - lookbackMs, nowMs);
  const windowAverage = live.reduce((total, reading) => total + (reading.averagePerHour ?? 0), 0);
  // Without enough provider history: each account's own rate (measured or average).
  const accountRates = live.reduce((total, reading) => total + (reading.ratePerHour ?? 0), 0);
  // Like each account: the faster of the measured rate and the window rates.
  if (measured && measured.coveredMs >= enoughMs && measured.ratePerHour > accountRates) {
    return {
      ratePerHour: measured.ratePerHour,
      source: 'history',
      coveredMs: measured.coveredMs,
      windowAverage,
    };
  }
  return {
    ratePerHour: accountRates,
    source: 'window',
    coveredMs: measured?.coveredMs ?? 0,
    windowAverage,
  };
}

/**
 * Per-account outlook at each account's own window rate (the same rate its
 * row shows): the first account to run out before its reset, and how much
 * quota is still unspent across the accounts when their windows reset.
 */
export function accountOutlook(
  live: LiveReading[],
  nowMs: number
): Pick<QuotaForecast, 'firstRunsOutAtMs' | 'outNow' | 'unusedAtResets' | 'unusedByAccount'> {
  let firstRunsOutAtMs: number | null = null;
  const outNow: QuotaForecast['outNow'] = { count: 0, backAtMs: null };
  const unusedByAccount: QuotaForecast['unusedByAccount'] = [];
  live.forEach((reading) => {
    if (reading.remaining <= 0) {
      outNow.count += 1;
      if (reading.resetAtMs !== null && reading.resetAtMs > nowMs) {
        outNow.backAtMs = Math.min(outNow.backAtMs ?? Infinity, reading.resetAtMs);
      }
      return;
    }
    if (reading.resetAtMs === null || reading.resetAtMs <= nowMs) return;
    const burn = burnOutcome(reading.remaining, reading.resetAtMs, reading.ratePerHour ?? 0, nowMs);
    if (burn.runsOutAtMs !== null) {
      firstRunsOutAtMs = Math.min(firstRunsOutAtMs ?? Infinity, burn.runsOutAtMs);
    }
    unusedByAccount.push({
      credentialId: reading.credentialId,
      unused: burn.unusedAtReset ?? 0,
      resetAtMs: reading.resetAtMs,
    });
  });
  unusedByAccount.sort((a, b) => a.resetAtMs - b.resetAtMs);
  return {
    firstRunsOutAtMs,
    outNow,
    unusedAtResets: unusedByAccount.reduce((total, item) => total + item.unused, 0),
    unusedByAccount,
  };
}

/**
 * Sawtooth projection from `nowMs`. Each credential burns at its own rate,
 * scaled so all of them add up to `drainPerHour` (an even split when none has
 * a rate). A credential stops at 0% and refills to 100% at each reset; its
 * next window burns at the same pace, so a reset is never a flat line.
 */
export function projectQuota(
  live: LiveReading[],
  drainPerHour: number,
  nowMs: number,
  untilMs: number
): { points: ChartPoint[]; resets: ResetEvent[] } {
  const rateTotal = live.reduce((total, reading) => total + (reading.ratePerHour ?? 0), 0);
  const credentials = live.map((reading) => ({
    ...reading,
    perMs:
      (rateTotal > 0
        ? ((reading.ratePerHour ?? 0) / rateTotal) * drainPerHour
        : drainPerHour / live.length) / HOUR_MS,
  }));
  const sum = () => credentials.reduce((total, item) => total + item.remaining, 0);
  const points: ChartPoint[] = [{ t: nowMs, v: sum() }];
  const resets: ResetEvent[] = [];

  let t = nowMs;
  while (t < untilMs) {
    const stepEnd = Math.min(t + PROJECTION_STEP_MS, untilMs);
    const due = credentials.filter(
      (item) => item.resetAtMs !== null && item.resetAtMs > t && item.resetAtMs <= stepEnd
    );
    const next =
      due.length > 0 ? Math.min(...due.map((item) => item.resetAtMs as number)) : stepEnd;

    credentials.forEach((item) => {
      item.remaining = Math.max(0, item.remaining - item.perMs * (next - t));
    });
    t = next;
    points.push({ t, v: sum() });

    const resetting = credentials.filter((item) => item.resetAtMs === t);
    if (resetting.length > 0) {
      const gain = resetting.reduce((total, item) => total + (100 - item.remaining), 0);
      resetting.forEach((item) => {
        item.remaining = 100;
        item.resetAtMs = item.periodHours ? t + item.periodHours * HOUR_MS : null;
      });
      const last = resets[resets.length - 1];
      if (last && t - last.atMs <= RESET_GROUP_MS) last.gain += gain;
      else resets.push({ atMs: t, gain });
      points.push({ t, v: sum() });
    }
  }
  return { points, resets };
}

export function buildQuotaForecast(input: ForecastInput): QuotaForecast {
  const { live, history, nowMs, rangeMs, lookbackMs, enoughMs } = input;
  const drain = currentDrain(live, history, nowMs, lookbackMs, enoughMs);
  const { points, resets } = projectQuota(live, drain.ratePerHour, nowMs, nowMs + rangeMs);
  const emptyPoint = points.find((point) => point.t > nowMs && point.v < 0.5);
  const outlook = accountOutlook(live, nowMs);
  return {
    capacity: live.length * 100,
    remaining: live.reduce((total, reading) => total + reading.remaining, 0),
    drain,
    history: aggregateHistory(history.filter((snapshot) => snapshot.ts <= nowMs)),
    readings: new Set(history.filter((snapshot) => snapshot.ts <= nowMs).map((s) => s.ts)).size,
    projection: points,
    nextReset: resets.find((event) => event.gain > 0.5) ?? null,
    allOutAtMs: emptyPoint?.t ?? null,
    ...outlook,
  };
}
