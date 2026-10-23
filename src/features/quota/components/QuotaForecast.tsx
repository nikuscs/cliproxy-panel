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
  FORECAST_RANGE_DAYS,
  DRAIN_RANGE_HOURS,
  type DrainRangeHours,
  type ForecastLookbackHours,
  type ForecastRangeDays,
} from '../constants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import {
  buildQuotaForecast,
  drainSeries,
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
  formatClockTime,
  formatCompactDuration,
  formatOutlookTime,
  formatPercent,
  formatRate,
  formatWeekdayTime,
  rateLabel,
} from '../display';
import { usePrivacyRevealed } from '../privacy';
import { ProviderIcon } from './ProviderIcon';
import { QuotaForecastChart } from './QuotaForecastChart';
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
  rangeDays: ForecastRangeDays;
  lookbackHours: ForecastLookbackHours;
  collapsed: boolean;
  onRangeDaysChange: (days: ForecastRangeDays) => void;
  onLookbackHoursChange: (hours: ForecastLookbackHours) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}

/**
 * The window to show by default: the one whose first account runs out
 * sooner; if neither runs out, the one with less left (as a share).
 */
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

/** The 5-hour view always looks one day ahead. */
const SESSION_RANGE_MS = DAY_MS;

/** Upper bound for the drain axis whose quarter ticks stay round. */
const niceCeil = (value: number) => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 4, 6, 8, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
};

/** "Next reset +200% · Tue 10:00 PM". */
function ResetNote({ forecast }: { forecast: QuotaForecastModel }) {
  const { t, i18n } = useTranslation();
  return (
    <span className={styles.resetNote}>
      {forecast.nextReset
        ? t('quota_management.forecast_next_reset', {
            gain: formatPercent(forecast.nextReset.gain),
            // With the date: "Fri 8:47 AM" is ambiguous on a Friday a week out.
            time: formatOutlookTime(forecast.nextReset.atMs, i18n.language),
          })
        : t('quota_management.forecast_no_reset')}
    </span>
  );
}

/**
 * "1 of 2 accounts out now · back in 26m (6:00 PM)" leads when any account is
 * at 0%. Then "At this pace: first account runs out in 1d 4h (Sat 24 Oct, 7:00 PM) · all
 * out in 5d 2h (…)", or "lasts until next reset · ~120% unused at resets".
 * Accounts use their own window rate; "all out" comes from the projection.
 */
function PaceNote({
  forecast,
  accounts,
  nowMs,
}: {
  forecast: QuotaForecastModel;
  accounts: number;
  nowMs: number;
}) {
  const { t, i18n } = useTranslation();
  // A native tooltip can't blur: name accounts only when revealed.
  const revealed = usePrivacyRevealed();
  // Today needs only the clock: "(6:00 PM)"; later days keep the date.
  const formatBackTime = (atMs: number) =>
    new Date(atMs).toDateString() === new Date(nowMs).toDateString()
      ? formatClockTime(atMs, i18n.language)
      : formatOutlookTime(atMs, i18n.language);
  const when = (atMs: number) => ({
    duration: formatCompactDuration(atMs - nowMs),
    time: formatOutlookTime(atMs, i18n.language),
  });
  const { outNow } = forecast;
  const first = forecast.firstRunsOutAtMs;
  const allOut = accounts > 1 ? forecast.allOutAtMs : null;
  // Accounts with quota left; when none, the line is only "out now · back in …".
  const draining = accounts - outNow.count;
  const unused = Math.round(forecast.unusedAtResets);
  // Each account has its own reset: name the first one, list all on hover.
  const firstReset = forecast.unusedByAccount[0]?.resetAtMs ?? null;
  const unusedDetail = forecast.unusedByAccount
    .map((item, index) =>
      t('quota_management.pace_unused_item', {
        name: revealed
          ? stripCredentialExtension(item.credentialId)
          : t('quota_management.privacy_account_n', { n: index + 1 }),
        unused: `${Math.round(item.unused)}%`,
        time: formatOutlookTime(item.resetAtMs, i18n.language),
      })
    )
    .join('\n');

  return (
    <p className={styles.pace}>
      {outNow.count > 0 && (
        <span className={styles.paceNow}>
          {t(accounts > 1 ? 'quota_management.pace_out_now' : 'quota_management.pace_out_now_one', {
            count: outNow.count,
            total: accounts,
            duration:
              outNow.backAtMs === null ? '' : formatCompactDuration(outNow.backAtMs - nowMs),
            time: outNow.backAtMs === null ? '' : formatBackTime(outNow.backAtMs),
          })}
        </span>
      )}
      {draining > 0 && (
        <>
          <span className={styles.pacePrefix}>{t('quota_management.pace_prefix')}</span>
          {first !== null ? (
            <span className={styles.paceOut}>
              {t(
                draining > 1 ? 'quota_management.pace_first_out' : 'quota_management.pace_runs_out',
                when(first)
              )}
            </span>
          ) : (
            <span className={styles.paceLasts}>{t('quota_management.pace_lasts')}</span>
          )}
          {allOut !== null ? (
            <span className={`${styles.paceOut} ${styles.paceMore}`}>
              {t('quota_management.pace_all_out', when(allOut))}
            </span>
          ) : unused > 0 && firstReset !== null ? (
            <span className={styles.paceMore} title={unusedDetail}>
              {t(
                forecast.unusedByAccount.length > 1
                  ? 'quota_management.pace_unused'
                  : 'quota_management.pace_unused_one',
                { unused: `${unused}%`, time: formatWeekdayTime(firstReset, i18n.language) }
              )}
            </span>
          ) : null}
        </>
      )}
    </p>
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
    rangeDays,
    lookbackHours,
    collapsed,
    onRangeDaysChange,
    onLookbackHoursChange,
    onCollapsedChange,
  } = props;
  const { t } = useTranslation();
  const [chartTab, setChartTab] = useState<ChartTab>('remaining');
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The user's 7-day / 5-hour choice; null follows the window closer to running out. */
  const [windowChoice, setWindowChoice] = useState<ForecastWindow | null>(null);
  /** The user's drain-chart range; null follows the recorded history. */
  const [drainRangeChoice, setDrainRangeChoice] = useState<DrainRangeHours | null>(null);

  const weeklyRangeMs = rangeDays * DAY_MS;
  const accent = FORECAST_ACCENTS[provider];
  const lookbackMs = lookbackHours * HOUR_MS;

  // One forecast per window. Each account's rate is its measured rate when its
  // readings cover enough time, else its window average (same rule as the rows).
  const views = useMemo(() => {
    const build = (window: ForecastWindow) => {
      // A 5-hour sawtooth is unreadable over a week: that view is the next 24h.
      const rangeMs = window === 'session' ? SESSION_RANGE_MS : weeklyRangeMs;
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
  }, [entries, history, lookbackMs, nowMs, quotaFor, snapshotsFor, weeklyRangeMs]);

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

  const rangeOptions = FORECAST_RANGE_DAYS.map((days) => ({
    value: String(days),
    label: t(`quota_management.forecast_range_${days}`),
  }));
  const drainRangeOptions = DRAIN_RANGE_HOURS.map((hours) => ({
    value: String(hours),
    label: t(`quota_management.forecast_drain_range_${hours}`),
  }));
  const lookbackOptions = FORECAST_LOOKBACK_HOURS.map((hours) => ({
    value: String(hours),
    label: t(`quota_management.forecast_lookback_${hours}`),
  }));
  const providerName = getTypeLabel(t, provider);
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
            {formatPercent(forecast.remaining)}
          </span>
          <span className={styles.capacity}>
            {t('quota_management.forecast_capacity', {
              capacity: formatPercent(forecast.capacity),
            })}
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
        {split && <PaceNote forecast={forecast} accounts={live.length} nowMs={nowMs} />}
        {(collapsed || split) && <ResetNote forecast={forecast} />}
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
      {!split && <PaceNote forecast={forecast} accounts={live.length} nowMs={nowMs} />}

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
                  {t(`quota_management.forecast_tab_${tab}`)}
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
                        ? 'quota_management.forecast_legend_remaining'
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
                {window === 'session' ? (
                  <span className={styles.rangeFixed}>
                    {t('quota_management.forecast_range_1')}
                  </span>
                ) : (
                  <Select
                    value={String(rangeDays)}
                    options={rangeOptions}
                    onChange={(value) => onRangeDaysChange(Number(value) as ForecastRangeDays)}
                    ariaLabel={t('quota_management.forecast_range_label')}
                    className={styles.quietSelect}
                    menuClassName={styles.quietMenu}
                    fullWidth={false}
                    size="sm"
                  />
                )}
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
            history={chartIsRemaining ? forecast.history : measuringNote ? [] : drainPast.segments}
            projection={chartIsRemaining ? forecast.projection : []}
            reference={
              chartIsRemaining
                ? null
                : {
                    value: drain.windowAverage,
                    label: t('quota_management.forecast_legend_average'),
                  }
            }
            accent={accent}
            label={t(`quota_management.forecast_tab_${chartTab}`)}
            formatValue={chartIsRemaining ? formatPercent : formatRate}
            compact={split}
            note={measuringNote}
          />

          {!split && (
            <div className={styles.footer}>
              <ResetNote forecast={forecast} />
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
