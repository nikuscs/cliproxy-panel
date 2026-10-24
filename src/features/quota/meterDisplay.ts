/**
 * How quota meters read on the quota page.
 *
 * - `mode`: show usage (`used`, the default on the quota page) or what is left.
 *   Values are stored as remaining everywhere; only the display flips.
 * - `atPace`: ids of meters that run out before their reset at the current
 *   pace; their bars turn red whatever their level.
 *
 * Outside a provider (the auth files page) meters keep the remaining view.
 */

import { createContext, useContext } from 'react';
import type { TFunction } from 'i18next';

export type QuotaDisplayMode = 'used' | 'remaining';

export const QUOTA_DISPLAY_MODES: readonly QuotaDisplayMode[] = ['used', 'remaining'];

export interface MeterDisplay {
  mode: QuotaDisplayMode;
  atPace: ReadonlySet<string>;
}

const NO_METERS_AT_PACE: ReadonlySet<string> = new Set();

export const MeterDisplayContext = createContext<MeterDisplay>({
  mode: 'remaining',
  atPace: NO_METERS_AT_PACE,
});

export const useMeterDisplay = () => useContext(MeterDisplayContext);

/** The value a meter shows: used or remaining, from its remaining percent. */
export const shownPercent = (remaining: number, mode: QuotaDisplayMode): number =>
  mode === 'used' ? Math.max(0, 100 - remaining) : remaining;

/**
 * A meter's percent label. In the used view it says so ("67% used"); the
 * remaining view keeps the provider's own wording (`remainingLabel`).
 */
export const meterPercentLabel = (
  t: TFunction,
  remaining: number,
  mode: QuotaDisplayMode,
  remainingLabel: string
): string =>
  mode === 'used'
    ? t('quota_management.percent_used', { percent: Math.round(shownPercent(remaining, mode)) })
    : remainingLabel;
