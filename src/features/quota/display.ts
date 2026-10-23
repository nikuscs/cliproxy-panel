/**
 * Small display helpers for the quota page: email masking and compact times.
 */

import type { TFunction } from 'i18next';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const EMAIL_PATTERN = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Mask every email in `text` to its first character and domain: `t•••@t3.gg`. */
export const maskEmails = (text: string): string => text.replace(EMAIL_PATTERN, '$1•••@$2');

/** Credential files are `<account>.json`; the extension is noise in a label. */
export const stripCredentialExtension = (name: string): string =>
  name.replace(/\.json(?=$| · )/i, '');

/** Dates and times never wrap mid-value (no orphaned "PM"). */
const unbreakable = (text: string): string => text.replace(/\s/g, '\u00a0');

/** `2d 7h`, `3h 12m`, `8m`; the parts never wrap apart. */
export function formatCompactDuration(ms: number): string {
  const safe = Math.max(0, ms);
  const days = Math.floor(safe / DAY_MS);
  const hours = Math.floor((safe % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((safe % HOUR_MS) / MINUTE_MS);
  if (days > 0) return hours > 0 ? `${days}d\u00a0${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h\u00a0${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

/**
 * The browser's regional variant of the UI language (`en` → `en-PT`), so
 * dates follow the user's region while matching the chosen language.
 */
export function resolveLocale(language?: string): string | undefined {
  if (!language || typeof navigator === 'undefined') return language;
  const base = language.toLowerCase().split('-')[0];
  return navigator.languages?.find((tag) => tag.toLowerCase().split('-')[0] === base) ?? language;
}

/** `Oct 11, 2:53 PM` in the user's locale. */
export const formatDateTime = (ms: number, locale?: string): string =>
  unbreakable(
    new Date(ms).toLocaleString(resolveLocale(locale), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  );

/** `Tue 10:00 PM` in the user's locale. */
export const formatWeekdayTime = (ms: number, locale?: string): string =>
  unbreakable(
    new Date(ms).toLocaleString(resolveLocale(locale), {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })
  );

/** `Mon 26 Oct, 3:20 PM` (order and clock follow the user's locale). */
export const formatOutlookTime = (ms: number, locale?: string): string =>
  unbreakable(
    new Date(ms).toLocaleString(resolveLocale(locale), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })
  );

/** `6:00 PM` in the user's locale. */
export const formatClockTime = (ms: number, locale?: string): string =>
  unbreakable(
    new Date(ms).toLocaleTimeString(resolveLocale(locale), { hour: 'numeric', minute: '2-digit' })
  );

export const formatPercent = (value: number): string => `${Math.round(value)}%`;

/** Smallest rate one decimal can show; anything below reads `<0.1%`, never `0.0%`. */
const MIN_RATE = 0.05;

/** `3.2%` below 10, `14%` above: rates need one decimal only when small. */
export const formatRate = (value: number): string =>
  value === 0
    ? '0%'
    : value < MIN_RATE
      ? '<0.1%'
      : `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;

/** The provider pace in words: "~2.4% per hour", "<0.1% per hour" or "idle". */
export const rateLabel = (t: TFunction, value: number): string =>
  value === 0
    ? t('quota_management.forecast_rate_idle')
    : value < MIN_RATE
      ? t('quota_management.forecast_rate_tiny', { rate: formatRate(value) })
      : t('quota_management.forecast_rate', { rate: formatRate(value) });
