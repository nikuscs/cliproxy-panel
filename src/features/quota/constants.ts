import type { QuotaProviderType } from './providers/types';

/** tab 顺序 = 旧页五分区的纵向顺序，'全部' tab 下卡片也按此分组排列。 */
export const QUOTA_TAB_ORDER: readonly QuotaProviderType[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
  'plugin',
];

export type QuotaTabId = 'all' | QuotaProviderType;

/** 页级分页固定 20/页，同时把「刷新全部」的上游并发限制在 20。 */
export const QUOTA_PAGE_SIZE = 20;

/** 卡片排序：默认 = provider 分组序；soonest = 最快恢复优先。 */
export const QUOTA_SORT_MODES = ['default', 'soonest'] as const;

export type QuotaSortMode = (typeof QUOTA_SORT_MODES)[number];

/** 与 useRevealGroup 的 GROUP_MAX_TOTAL 一致：卡片级联总预算 360ms。 */
export const CARD_ENTRANCE_BUDGET_MS = 360;

/** Page entry refreshes credentials whose shown data is older than this. */
export const QUOTA_STALE_MS = 5 * 60_000;

/** Card grid (upstream) or one row per credential. */
export const QUOTA_VIEW_MODES = ['ledger', 'cards'] as const;

export type QuotaViewMode = (typeof QUOTA_VIEW_MODES)[number];

/** Drain-rate lookback choices, in hours. */
export const FORECAST_LOOKBACK_HOURS = [6, 24, 72] as const;

export type ForecastLookbackHours = (typeof FORECAST_LOOKBACK_HOURS)[number];

/** How far back the "Drain rate" chart looks, in hours. */
export const DRAIN_RANGE_HOURS = [6, 24, 168] as const;

export type DrainRangeHours = (typeof DRAIN_RANGE_HOURS)[number];

/** Forecast chart accent per provider (dark-first, matches the brand marks). */
export const FORECAST_ACCENTS: Record<QuotaProviderType, string> = {
  claude: '#e07b5f',
  antigravity: '#5b8def',
  codex: '#8f8cf7',
  xai: '#d4d4d8',
  kimi: '#4f9cff',
  devin: '#3ecf8e',
  meta: '#4a7dff',
  plugin: '#a1a1aa',
};
