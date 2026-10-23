/**
 * Quota state from the passive snapshot CLIProxyAPI attaches to each credential
 * in the auth-files list: `quota: { observed_at, signals }`, captured from the
 * latest upstream response headers while the proxy is used (server memory
 * only; empty after a server restart).
 *
 * Header names and formats follow CPA's sdk/cliproxy/auth/quota_signals.go:
 *   Claude: Anthropic-Ratelimit-Unified-{5h,7d}-Utilization  fraction 0..1
 *           Anthropic-Ratelimit-Unified-{5h,7d}-Reset        unix seconds
 *   Codex:  X-Codex-{Primary,Secondary}-Used-Percent         0..100
 *           X-Codex-{Primary,Secondary}-Window-Minutes       e.g. 300, 10080
 *           X-Codex-{Primary,Secondary}-Reset-At             unix seconds
 *           X-Codex-{Primary,Secondary}-Reset-After-Seconds  relative fallback
 *           X-Codex-Plan-Type
 * Signal keys are canonical HTTP header names; they are matched case-insensitively.
 *
 * Builds the same state shapes the Claude/Codex adapters build, so cards,
 * ledger rows and the forecast read it unchanged. A live fetch overrides it.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';
import { formatInstantShort } from '@/utils/quota/relativeTime';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';

export interface PassiveQuota {
  state: QuotaCardState;
  observedAtMs: number;
}

interface WindowReading {
  usedPercent: number;
  resetAtMs: number | null;
  periodHours: number;
}

const readSignals = (
  file: AuthFileItem
): { signals: Map<string, string>; observedAtMs: number } | null => {
  const quota = file.quota as { observed_at?: unknown; signals?: unknown } | undefined;
  if (!quota || typeof quota !== 'object' || !quota.signals || typeof quota.signals !== 'object') {
    return null;
  }
  // Go writes RFC 3339 with nanoseconds; keep milliseconds so every engine parses it.
  const observedAtMs =
    typeof quota.observed_at === 'string'
      ? Date.parse(quota.observed_at.replace(/(\.\d{3})\d+/, '$1'))
      : NaN;
  if (!Number.isFinite(observedAtMs)) return null;
  const signals = new Map<string, string>();
  Object.entries(quota.signals as Record<string, unknown>).forEach(([name, value]) => {
    if (typeof value === 'string') signals.set(name.toLowerCase(), value.trim());
  });
  return signals.size > 0 ? { signals, observedAtMs } : null;
};

const numberOf = (value: string | undefined) => {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const unixToMs = (value: string | undefined) => {
  const seconds = numberOf(value);
  return seconds !== null && seconds > 0 ? seconds * 1000 : null;
};

function claudeState(
  signals: Map<string, string>,
  observedAtMs: number,
  t: TFunction
): ClaudeQuotaState | null {
  const window = (key: '5h' | '7d', periodHours: number): WindowReading | null => {
    const utilization = numberOf(signals.get(`anthropic-ratelimit-unified-${key}-utilization`));
    if (utilization === null) return null;
    return {
      usedPercent: Math.min(100, Math.max(0, utilization * 100)),
      resetAtMs: unixToMs(signals.get(`anthropic-ratelimit-unified-${key}-reset`)),
      periodHours,
    };
  };
  const windows = [
    { id: 'five-hour', labelKey: 'claude_quota.five_hour', reading: window('5h', 5) },
    { id: 'seven-day', labelKey: 'claude_quota.seven_day', reading: window('7d', 168) },
  ]
    .filter((item) => item.reading !== null)
    .map(({ id, labelKey, reading }) => ({
      id,
      label: t(labelKey),
      labelKey,
      usedPercent: (reading as WindowReading).usedPercent,
      resetLabel: reading?.resetAtMs ? formatInstantShort(reading.resetAtMs) : '-',
      resetAtMs: (reading as WindowReading).resetAtMs,
      periodHours: (reading as WindowReading).periodHours,
    }));
  if (windows.length === 0) return null;
  return {
    status: 'success',
    windows,
    dollarWindows: [],
    extraUsage: null,
    planType: null,
    observedAt: new Date(observedAtMs).toISOString(),
    stale: false,
  };
}

function codexState(
  signals: Map<string, string>,
  observedAtMs: number,
  t: TFunction
): CodexQuotaState | null {
  const windows = (['primary', 'secondary'] as const)
    .map((slot) => {
      const usedPercent = numberOf(signals.get(`x-codex-${slot}-used-percent`));
      const minutes = numberOf(signals.get(`x-codex-${slot}-window-minutes`));
      if (usedPercent === null || minutes === null || minutes <= 0) return null;
      const resetAfter = numberOf(signals.get(`x-codex-${slot}-reset-after-seconds`));
      const resetAtMs =
        unixToMs(signals.get(`x-codex-${slot}-reset-at`)) ??
        (resetAfter !== null ? observedAtMs + resetAfter * 1000 : null);
      // Codex puts whichever window is binding in "primary", so the length,
      // not the slot, decides the window. Same ids as the live adapter
      // (buildCodexQuotaWindows), so a passive update merges into the match.
      const isFiveHour = minutes === 5 * 60;
      const isWeekly = minutes === 7 * 24 * 60;
      const isMonthly = minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60;
      const labelKey = isFiveHour
        ? 'codex_quota.primary_window'
        : isWeekly
          ? 'codex_quota.secondary_window'
          : isMonthly
            ? 'codex_quota.team_secondary_window'
            : undefined;
      return {
        id: isFiveHour
          ? 'five-hour'
          : isWeekly
            ? 'weekly'
            : isMonthly
              ? 'monthly'
              : `window-${minutes}`,
        label: labelKey ? t(labelKey) : `${Math.round(minutes / 60)}h`,
        labelKey,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetLabel: resetAtMs ? formatInstantShort(resetAtMs) : '-',
        resetAtMs,
        periodHours: minutes / 60,
      };
    })
    .filter((window): window is NonNullable<typeof window> => window !== null)
    .sort((a, b) => a.periodHours - b.periodHours);
  if (windows.length === 0) return null;
  return {
    status: 'success',
    windows,
    planType: signals.get('x-codex-plan-type') || null,
    rateLimitResetCredits: [],
    rateLimitResetCreditsError: '',
  } as CodexQuotaState;
}

/** Quota state from the credential's passive snapshot, or null when it has none. */
export function passiveQuotaFor(
  provider: QuotaProviderType,
  file: AuthFileItem,
  t: TFunction
): PassiveQuota | null {
  if (provider !== 'claude' && provider !== 'codex') return null;
  const snapshot = readSignals(file);
  if (!snapshot) return null;
  const state =
    provider === 'claude'
      ? claudeState(snapshot.signals, snapshot.observedAtMs, t)
      : codexState(snapshot.signals, snapshot.observedAtMs, t);
  return state ? { state: state as QuotaCardState, observedAtMs: snapshot.observedAtMs } : null;
}
