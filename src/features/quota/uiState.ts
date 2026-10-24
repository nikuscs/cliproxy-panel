import {
  FORECAST_LOOKBACK_HOURS,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  QUOTA_VIEW_MODES,
  type ForecastLookbackHours,
  type QuotaSortMode,
  type QuotaTabId,
  type QuotaViewMode,
} from './constants';
import { QUOTA_DISPLAY_MODES, type QuotaDisplayMode } from './meterDisplay';
import type { QuotaProviderType } from './providers/types';

/** 额度页 UI 偏好：会话级持久化（sessionStorage），跨会话不携带。 */
export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: isQuotaTabId(parsed.tab) ? parsed.tab : undefined,
      sortMode: isQuotaSortMode(parsed.sortMode) ? parsed.sortMode : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};

/**
 * Durable display preferences (localStorage): unlike the tab and sort above,
 * these describe how the user likes the page, not where they left it.
 */
export type QuotaPreferences = {
  showEmails: boolean;
  /** Meters show usage (default) or what is left. */
  displayMode: QuotaDisplayMode;
  /** View on a single provider tab. */
  viewMode: QuotaViewMode;
  /** View on the All tab (upstream card grid by default). */
  allViewMode: QuotaViewMode;
  forecastLookbackHours: ForecastLookbackHours;
  /** Providers whose forecast panel is collapsed. */
  collapsedForecasts: QuotaProviderType[];
  /** Providers that had credentials at the last load (tabs shown before the list loads). */
  knownProviders: QuotaProviderType[];
};

const QUOTA_PREFERENCES_KEY = 'quotaPage.preferences';

const DEFAULT_QUOTA_PREFERENCES: QuotaPreferences = {
  showEmails: false,
  displayMode: 'used',
  viewMode: 'ledger',
  allViewMode: 'cards',
  forecastLookbackHours: 24,
  collapsedForecasts: [],
  knownProviders: [],
};

const providerList = (value: unknown): QuotaProviderType[] =>
  Array.isArray(value)
    ? value.filter((id): id is QuotaProviderType => isQuotaTabId(id) && id !== 'all')
    : [];

const oneOf = <T>(values: readonly T[], value: unknown, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

export const readQuotaPreferences = (): QuotaPreferences => {
  const defaults = DEFAULT_QUOTA_PREFERENCES;
  if (typeof window === 'undefined') return defaults;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(QUOTA_PREFERENCES_KEY) ?? '{}');
    return {
      showEmails: parsed.showEmails === true,
      displayMode: oneOf(QUOTA_DISPLAY_MODES, parsed.displayMode, defaults.displayMode),
      viewMode: oneOf(QUOTA_VIEW_MODES, parsed.viewMode, defaults.viewMode),
      allViewMode: oneOf(QUOTA_VIEW_MODES, parsed.allViewMode, defaults.allViewMode),
      forecastLookbackHours: oneOf(
        FORECAST_LOOKBACK_HOURS,
        parsed.forecastLookbackHours,
        defaults.forecastLookbackHours
      ),
      collapsedForecasts: providerList(parsed.collapsedForecasts),
      knownProviders: providerList(parsed.knownProviders),
    };
  } catch {
    return defaults;
  }
};

export const writeQuotaPreferences = (preferences: Partial<QuotaPreferences>) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaPreferences(), ...preferences };
    window.localStorage.setItem(QUOTA_PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};
