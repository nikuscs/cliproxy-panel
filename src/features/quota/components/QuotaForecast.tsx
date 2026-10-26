/**
 * Provider forecast panel: total remaining weekly quota, current drain rate, a
 * history + projection chart, the next reset and when the provider runs out.
 *
 * The drain rate works on the first load: it comes from each window's own
 * average since it opened, and switches to the panel's recorded history (the
 * backend stores none) once enough of it covers the lookback.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconChevronUp } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import type { ResolvedTheme } from '@/types';
import { getTypeLabel } from '@/features/authFiles/constants';
import { HOUR_MS, DAY_MS } from '@/utils/time/durations';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  FORECAST_ACCENTS,
  FORECAST_LOOKBACK_HOURS,
  DRAIN_RANGE_HOURS,
  type DrainRangeHours,
  type ForecastLookbackHours,
} from '../constants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import {
  buildQuotaForecast,
  drainSeries,
  type ChartPoint,
  type LiveReading,
  type QuotaForecast as QuotaForecastModel,
} from '../forecast/forecastModel';
import type { QuotaSnapshot } from '../forecast/quotaHistory';
import {
  meterForWindow,
  resolveMeterRate,
  snapshotsForWindow,
  windowMeasurement,
  type ForecastWindow,
} from '../forecast/forecastWindows';
import type { SnapshotsFor } from '../hooks/useQuotaHistory';
import { meterAsOf, readQuotaMeters } from '../forecast/quotaMeters';
import {
  stripCredentialExtension,
  formatCompactDuration,
  formatOutlookTime,
  formatPercent,
  formatRate,
  rateLabel,
} from '../display';
import { usePrivacyRevealed } from '../privacy';
import { useMeterDisplay } from '../meterDisplay';
import { ProviderIcon } from './ProviderIcon';
import { DetailPopover } from './DetailPopover';
import { QuotaForecastChart, type ChartMarker } from './QuotaForecastChart';
import styles from './QuotaForecast.module.scss';

type ChartTab = 'remaining' | 'drain';

export interface QuotaForecastProps {
  provider: QuotaProviderType;
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  /** This provider's recorded snapshots (all windows). */
  history: QuotaSnapshot[];
  snapshotsFor: SnapshotsFor;
  nowMs: number;
  resolvedTheme: ResolvedTheme;
  /**
   * `split` is the All tab's compact block: provider, numbers and controls on
   * the left, the chart on the right. `stacked` is the single-provider panel.
   */
  layout: 'stacked' | 'split';
  chartHeight: number;
  lookbackHours: ForecastLookbackHours;
  collapsed: boolean;
  onLookbackHoursChange: (hours: ForecastLookbackHours) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}

/**
 * The window to show by default: the one whose first account runs out
 * sooner; if neither runs out, the one with less left (as a share).
 */
/**
 * The plugin these entries belong to, when they agree on one.
 *
 * Every plugin-backed credential shares the single `plugin` provider, so the
 * panel header reads "Plugin" whichever plugin it actually is. Naming it after
 * the plugin is the difference between "Plugin" and "Cursor". Entries from two
 * different plugins keep the generic name rather than picking a winner.
 */
function quotaPluginName(entries: QuotaFileEntry[]): string | null {
  const ids = new Set<string>();
  for (const entry of entries) {
    const file = entry.file as { quotaPluginId?: unknown; quota_plugin_id?: unknown };
    const id = file.quotaPluginId ?? file['quota_plugin_id'];
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  if (ids.size !== 1) return null;
  const [only] = [...ids];
  return only ?? null;
}

function closerToRunningOut(
  weekly: QuotaForecastModel,
  session: QuotaForecastModel | null
): ForecastWindow {
  if (!session) return 'weekly';
  const weeklyOut = weekly.firstRunsOutAtMs;
  const sessionOut = session.firstRunsOutAtMs;
  if (sessionOut !== null && (weeklyOut === null || sessionOut < weeklyOut)) return 'session';
  if (weeklyOut !== null) return 'weekly';
  const share = (forecast: QuotaForecastModel) =>
    forecast.capacity > 0 ? forecast.remaining / forecast.capacity : 1;
  return share(session) < share(weekly) ? 'session' : 'weekly';
}

/** How far each view looks ahead: a day for 5-hour windows, a week for weekly. */
const RANGE_DAYS: Record<ForecastWindow, 1 | 7> = { session: 1, weekly: 7 };

/** Upper bound for the drain axis whose quarter ticks stay round. */
const niceCeil = (value: number) => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 4, 6, 8, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
};

/**
 * How serious the outlook is, for the table and the chart markers:
 * - `out`: every account is out now, or all of them run out before their resets;
 * - `warn`: some account runs out before its reset, others still cover;
 * - `ok`: nothing runs out (an account already out is covered by the rest).
 */
type OutlookTone = 'out' | 'warn' | 'ok';

const TONE_CLASS: Record<OutlookTone, string> = {
  out: styles.toneOut,
  warn: styles.toneWarn,
  ok: styles.toneOk,
};

function outlookTone(forecast: QuotaForecastModel, accounts: number): OutlookTone {
  const draining = accounts - forecast.outNow.count;
  if (draining <= 0) return 'out';
  if (forecast.firstRunsOutAtMs === null) return 'ok';
  const allRunOut = draining === 1 || (accounts > 1 && forecast.allOutAtMs !== null);
  return allRunOut ? 'out' : 'warn';
}

/**
 * The outlook as a small table, short values first; exact times and the
 * per-account split are in each value's popover. Rows take the outlook's tone.
 * - Free now: "286% on 5 of 6 accounts", when any account is at 0%.
 * - Limit hit: "1 of 2 accounts · resets in 26m", when any account is at 0%. The
 *   one-account key avoids a `_one` suffix: i18next reads that as the plural
 *   form of `pace_out_now` whenever `count` is 1.
 * - At this pace: "first account out in 1d 4h", or "lasts until next reset".
 * - All out: "in 5d 2h"; or Unused at reset: "~120%".
 * - Next reset: "+200% in 18h" ("frees 200%" in the used view).
 * Accounts use their own window rate; "all out" comes from the projection.
 */
function Outlook({
  forecast,
  accounts,
  nowMs,
}: {
  forecast: QuotaForecastModel;
  accounts: number;
  nowMs: number;
}) {
  const { t, i18n } = useTranslation();
  const { mode } = useMeterDisplay();
  // The popover can't blur one name: name accounts only when revealed.
  const revealed = usePrivacyRevealed();
  const duration = (atMs: number) => formatCompactDuration(atMs - nowMs);
  const time = (atMs: number) => formatOutlookTime(atMs, i18n.language);
  const { outNow, nextReset } = forecast;
  const first = forecast.firstRunsOutAtMs;
  const allOut = accounts > 1 ? forecast.allOutAtMs : null;
  // Accounts with quota left; when none, only "out now" and the reset show.
  const draining = accounts - outNow.count;
  const unused = Math.round(forecast.unusedAtResets);
  const tone = TONE_CLASS[outlookTone(forecast, accounts)];
  const unusedDetail = forecast.unusedByAccount
    .map((item, index) =>
      t('quota_management.pace_unused_item', {
        name: revealed
          ? stripCredentialExtension(item.credentialId)
          : t('quota_management.privacy_account_n', { n: index + 1 }),
        unused: `${Math.round(item.unused)}%`,
        time: time(item.resetAtMs),
      })
    )
    .join('\n');

  const rows: { label: string; value: string; tone?: string; detail?: string }[] = [];
  if (outNow.count > 0 && accounts > 1) {
    rows.push({
      label: t('quota_management.pace_label_free_now'),
      value: t('quota_management.pace_free_now', {
        free: formatPercent(forecast.remaining),
        usable: draining,
        total: accounts,
      }),
      tone,
    });
  }
  if (outNow.count > 0) {
    rows.push({
      label: t('quota_management.pace_label_out_now'),
      value: t(
        accounts > 1 ? 'quota_management.pace_out_now' : 'quota_management.pace_out_now_single',
        {
          count: outNow.count,
          total: accounts,
          duration: outNow.backAtMs === null ? '' : duration(outNow.backAtMs),
        }
      ),
      tone,
      detail: outNow.backAtMs === null ? undefined : time(outNow.backAtMs),
    });
  }
  if (draining > 0) {
    rows.push(
      first !== null
        ? {
            label: t('quota_management.pace_label_pace'),
            value: t(
              draining > 1 ? 'quota_management.pace_first_out' : 'quota_management.pace_runs_out',
              { duration: duration(first) }
            ),
            tone,
            detail: time(first),
          }
        : {
            label: t('quota_management.pace_label_pace'),
            value: t('quota_management.pace_lasts'),
            tone: styles.toneOk,
          }
    );
    if (allOut !== null) {
      rows.push({
        label: t('quota_management.pace_label_all_out'),
        value: t('quota_management.pace_all_out', { duration: duration(allOut) }),
        tone: styles.toneOut,
        detail: time(allOut),
      });
    } else if (unused > 0 && forecast.unusedByAccount.length > 0) {
      rows.push({
        label: t('quota_management.pace_label_unused'),
        value: `~${unused}%`,
        detail: unusedDetail,
      });
    }
  }
  if (nextReset) {
    rows.push({
      label: t('quota_management.pace_label_next_reset'),
      value: t(
        mode === 'used' ? 'quota_management.pace_reset_frees' : 'quota_management.pace_reset_adds',
        { gain: formatPercent(nextReset.gain), duration: duration(nextReset.atMs) }
      ),
      detail: time(nextReset.atMs),
    });
  }

  return (
    <dl className={styles.outlook}>
      {rows.map((row) => (
        <div key={row.label} className={styles.outlookRow}>
          <dt>{row.label}</dt>
          <dd className={row.tone}>
            {row.detail ? (
              <DetailPopover detail={row.detail}>{row.value}</DetailPopover>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function QuotaForecast(props: QuotaForecastProps) {
  const {
    provider,
    entries,
    quotaFor,
    history,
    snapshotsFor,
    nowMs,
    resolvedTheme,
    layout,
    chartHeight,
    lookbackHours,
    collapsed,
    onLookbackHoursChange,
    onCollapsedChange,
  } = props;
  const { t } = useTranslation();
  const { mode: displayMode } = useMeterDisplay();
  const [chartTab, setChartTab] = useState<ChartTab>('remaining');
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The user's 7-day / 5-hour choice; null follows the window closer to running out. */
  const [windowChoice, setWindowChoice] = useState<ForecastWindow | null>(null);
  /** The user's drain-chart range; null follows the recorded history. */
  const [drainRangeChoice, setDrainRangeChoice] = useState<DrainRangeHours | null>(null);

  const accent = FORECAST_ACCENTS[provider];
  const lookbackMs = lookbackHours * HOUR_MS;

  // One forecast per window. Each account's rate is its measured rate when its
  // readings cover enough time, else its window average (same rule as the rows).
  const views = useMemo(() => {
    const build = (window: ForecastWindow) => {
      // A 5-hour sawtooth is unreadable over a week: that view is the next 24h.
      const rangeMs = RANGE_DAYS[window] * DAY_MS;
      const pastMs = rangeMs / 6;
      const windowHistory = snapshotsForWindow(history, window);
      const live = entries
        .map((entry): LiveReading | null => {
          const meter = meterForWindow(
            readQuotaMeters(entry.type, quotaFor(entry)).map((item) => meterAsOf(item, nowMs)),
            window
          );
          if (!meter) return null;
          const credentialId = getQuotaCacheKey(entry.file);
          const rate = resolveMeterRate(
            meter,
            snapshotsFor(credentialId, meter.id),
            nowMs,
            lookbackMs
          );
          return {
            credentialId,
            remaining: meter.remaining,
            resetAtMs: meter.resetAtMs,
            periodHours: meter.periodHours,
            ratePerHour: rate.ratePerHour,
            averagePerHour: rate.averagePerHour,
          };
        })
        .filter((reading): reading is LiveReading => reading !== null);
      const rule = windowMeasurement(window, lookbackMs);
      const forecast = buildQuotaForecast({
        live,
        history: windowHistory,
        nowMs,
        rangeMs,
        lookbackMs: rule.lookbackMs,
        enoughMs: rule.enoughMs,
      });
      return { live, forecast, rangeMs, pastMs, windowHistory };
    };
    return { weekly: build('weekly'), session: build('session') };
  }, [entries, history, lookbackMs, nowMs, quotaFor, snapshotsFor]);

  const hasSession = views.session.live.length > 0;
  const window: ForecastWindow =
    windowChoice === 'session' && hasSession
      ? 'session'
      : windowChoice === 'weekly'
        ? 'weekly'
        : closerToRunningOut(views.weekly.forecast, hasSession ? views.session.forecast : null);
  const { live, forecast, rangeMs, pastMs, windowHistory } = views[window];

  // The drain chart looks back: by default as far as the recorded readings go.
  const recordedMs = windowHistory.length
    ? nowMs - Math.min(...windowHistory.map((snapshot) => snapshot.ts))
    : 0;
  const drainRange =
    drainRangeChoice ??
    DRAIN_RANGE_HOURS.find((hours) => hours * HOUR_MS >= recordedMs) ??
    DRAIN_RANGE_HOURS[DRAIN_RANGE_HOURS.length - 1];
  const drainPast = useMemo(
    () => drainSeries(windowHistory, nowMs, drainRange * HOUR_MS),
    [windowHistory, nowMs, drainRange]
  );

  const drainRangeOptions = DRAIN_RANGE_HOURS.map((hours) => ({
    value: String(hours),
    label: t(`quota_management.forecast_drain_range_${hours}`),
  }));
  const lookbackOptions = FORECAST_LOOKBACK_HOURS.map((hours) => ({
    value: String(hours),
    label: t(`quota_management.forecast_lookback_${hours}`),
  }));
  const providerName = getTypeLabel(t, quotaPluginName(entries) ?? provider);
  const split = layout === 'split';
  const providerLabel = split ? (
    <span className={styles.provider}>
      <ProviderIcon provider={provider} resolvedTheme={resolvedTheme} size="sm" />
      <span className={styles.providerName}>{providerName}</span>
    </span>
  ) : null;

  if (live.length === 0) {
    return (
      <section className={`${styles.panel} ${styles.panelEmpty}`}>
        {providerLabel}
        <p className={styles.empty}>{t('quota_management.forecast_empty')}</p>
      </section>
    );
  }

  const { drain } = forecast;
  const measured = drain.source === 'history';
  // Scale to what is on screen (visible measured buckets and both rates) so a
  // small rate is clearly above the baseline.
  const drainMax = niceCeil(
    Math.max(
      drain.ratePerHour,
      drain.windowAverage,
      ...drainPast.segments.flat().map((point) => point.v)
    ) * 1.3
  );
  const measuringNote =
    // A line needs two points; fewer is a note, not an empty plot.
    chartTab === 'drain' && drainPast.segments.flat().length < 2
      ? t('quota_management.forecast_measuring', { count: forecast.readings })
      : null;
  const chartIsRemaining = chartTab === 'remaining';
  // First account out (yellow while others cover) and all out (red).
  const chartMarkers: ChartMarker[] = [];
  if (forecast.firstRunsOutAtMs !== null) {
    chartMarkers.push({
      atMs: forecast.firstRunsOutAtMs,
      label: t(
        live.length > 1 ? 'quota_management.forecast_first_out' : 'quota_management.forecast_limit'
      ),
      tone: outlookTone(forecast, live.length) === 'warn' ? 'warn' : 'out',
    });
  }
  if (live.length > 1 && forecast.allOutAtMs !== null) {
    chartMarkers.push({
      atMs: forecast.allOutAtMs,
      label: t('quota_management.forecast_all_out'),
      tone: 'out',
    });
  }
  // The used view flips every quota value: capacity minus what is left.
  const used = displayMode === 'used';
  const asShown = (points: ChartPoint[]) =>
    used ? points.map((point) => ({ t: point.t, v: forecast.capacity - point.v })) : points;
  const tabLabel = (tab: ChartTab) =>
    t(
      tab === 'remaining' && used
        ? 'quota_management.forecast_tab_used'
        : `quota_management.forecast_tab_${tab}`
    );
  const rateHint = measured
    ? t('quota_management.forecast_rate_source_measured', {
        // Whole hours read better than "17h 59m" for a coverage figure.
        covered: formatCompactDuration(
          drain.coveredMs >= 2 * HOUR_MS
            ? Math.round(drain.coveredMs / HOUR_MS) * HOUR_MS
            : drain.coveredMs
        ),
      })
    : t('quota_management.forecast_rate_source_window');
  const toggleLabel = t(
    collapsed ? 'quota_management.forecast_expand' : 'quota_management.forecast_collapse'
  );

  return (
    <section
      className={`${styles.panel} ${split ? styles.split : ''}`.trim()}
      aria-label={`${t('quota_management.forecast_title')} · ${providerName}`}
    >
      <div className={styles.summary}>
        {providerLabel}
        <p className={styles.totals}>
          <span className={styles.bigNumber} style={{ color: accent }}>
            {formatPercent(used ? forecast.capacity - forecast.remaining : forecast.remaining)}
          </span>
          <span className={styles.capacity}>
            {t(
              used
                ? 'quota_management.forecast_capacity_used'
                : 'quota_management.forecast_capacity',
              {
                capacity: formatPercent(forecast.capacity),
              }
            )}
          </span>
          <span className={styles.rate}>
            {rateLabel(t, drain.ratePerHour)}
            <span className={styles.rateHint}>{rateHint}</span>
          </span>
        </p>
        {hasSession && (
          <div
            className={styles.windowToggle}
            role="group"
            aria-label={t('quota_management.forecast_window_label')}
          >
            {(['session', 'weekly'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={window === option}
                className={window === option ? styles.windowActive : undefined}
                onClick={() => setWindowChoice(option)}
              >
                {t(`quota_management.forecast_window_${option}`)}
              </button>
            ))}
          </div>
        )}
        {split && <Outlook forecast={forecast} accounts={live.length} nowMs={nowMs} />}
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => onCollapsedChange(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          {collapsed ? <IconChevronDown size={16} /> : <IconChevronUp size={16} />}
        </button>
      </div>
      {!split && <Outlook forecast={forecast} accounts={live.length} nowMs={nowMs} />}

      {!collapsed && (
        <>
          <div className={styles.chartBar}>
            <div className={styles.tabs} role="tablist">
              {(['remaining', 'drain'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={chartTab === tab}
                  className={`${styles.tab} ${chartTab === tab ? styles.tabActive : ''}`}
                  style={chartTab === tab ? { color: accent, borderColor: accent } : undefined}
                  onClick={() => setChartTab(tab)}
                >
                  {tabLabel(tab)}
                </button>
              ))}
            </div>
            {!split && (
              <div className={styles.legend}>
                {(chartIsRemaining || measured || drainPast.segments.length > 0) && (
                  <span className={styles.legendItem}>
                    <span className={styles.legendDot} style={{ background: accent }} />
                    {t(
                      chartIsRemaining
                        ? used
                          ? 'quota_management.forecast_legend_used'
                          : 'quota_management.forecast_legend_remaining'
                        : 'quota_management.forecast_legend_measured'
                    )}
                  </span>
                )}
                {chartIsRemaining ? (
                  <span className={styles.legendItem} style={{ color: accent }}>
                    <span className={styles.legendDash} />
                    {t('quota_management.forecast_legend_projected')}
                  </span>
                ) : (
                  <span className={`${styles.legendItem} ${styles.legendReference}`}>
                    <span className={styles.legendDash} />
                    {t('quota_management.forecast_legend_average')}
                  </span>
                )}
              </div>
            )}
            {chartIsRemaining ? (
              <div className={styles.range}>
                <span>{t('quota_management.forecast_next')}</span>
                <span className={styles.rangeFixed}>
                  {t(`quota_management.forecast_range_${RANGE_DAYS[window]}`)}
                </span>
              </div>
            ) : (
              <div className={styles.range}>
                <span>{t('quota_management.forecast_last')}</span>
                <Select
                  value={String(drainRange)}
                  options={drainRangeOptions}
                  onChange={(value) => setDrainRangeChoice(Number(value) as DrainRangeHours)}
                  ariaLabel={t('quota_management.forecast_drain_range_label')}
                  className={styles.quietSelect}
                  menuClassName={styles.quietMenu}
                  fullWidth={false}
                  size="sm"
                />
              </div>
            )}
          </div>

          <QuotaForecastChart
            height={chartHeight}
            // Drain is measured from the past: that chart ends at now.
            startMs={chartIsRemaining ? nowMs - pastMs : drainPast.startMs}
            endMs={chartIsRemaining ? nowMs + rangeMs : nowMs}
            nowMs={nowMs}
            yMax={chartIsRemaining ? Math.max(forecast.capacity, 100) : drainMax}
            history={
              chartIsRemaining
                ? forecast.history.map(asShown)
                : measuringNote
                  ? []
                  : drainPast.segments
            }
            projection={chartIsRemaining ? asShown(forecast.projection) : []}
            markers={chartIsRemaining ? chartMarkers : []}
            reference={
              chartIsRemaining
                ? null
                : {
                    value: drain.windowAverage,
                    label: t('quota_management.forecast_legend_average'),
                  }
            }
            accent={accent}
            label={tabLabel(chartTab)}
            formatValue={chartIsRemaining ? formatPercent : formatRate}
            compact={split}
            note={measuringNote}
          />

          {!split && (
            <div className={styles.footer}>
              <button
                type="button"
                className={styles.settingsToggle}
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <IconChevronDown
                  size={13}
                  className={`${styles.caret} ${settingsOpen ? styles.caretOpen : ''}`}
                  aria-hidden="true"
                />
                {t('quota_management.forecast_settings')}
              </button>
            </div>
          )}

          {settingsOpen && !split && (
            <div className={styles.settings}>
              <span className={styles.settingHint}>
                {t('quota_management.forecast_settings_hint')}
              </span>
              <span className={styles.setting}>
                <span>{t('quota_management.forecast_lookback')}</span>
                <Select
                  value={String(lookbackHours)}
                  options={lookbackOptions}
                  onChange={(value) =>
                    onLookbackHoursChange(Number(value) as ForecastLookbackHours)
                  }
                  ariaLabel={t('quota_management.forecast_lookback')}
                  className={styles.quietSelect}
                  menuClassName={styles.quietMenu}
                  fullWidth={false}
                  size="sm"
                />
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
