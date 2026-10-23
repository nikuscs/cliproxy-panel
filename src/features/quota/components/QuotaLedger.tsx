/**
 * Ledger view: one compact row per credential, grouped under a one-line
 * provider card that totals each limit across the group. The card grid stays
 * the other view mode.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { getTypeLabel } from '@/features/authFiles/constants';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaFileEntry } from '../logic';
import type { QuotaProviderType } from '../providers/types';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import {
  exhaustedUntilMs,
  meterAsOf,
  meterLabel,
  orderedMeters,
  readQuotaMeters,
  type QuotaMeterReading,
} from '../forecast/quotaMeters';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import { QuotaEntryActions } from './QuotaEntryActions';
import { QuotaPrediction } from './QuotaPrediction';
import { PrivateValue } from './PrivateValue';
import { ProviderIcon } from './ProviderIcon';
import {
  stripCredentialExtension,
  formatCompactDuration,
  formatDateTime,
  formatPercent,
  formatRate,
  formatWeekdayTime,
} from '../display';
import { resolveMeterRate, type ResolvedRate } from '../forecast/forecastWindows';
import type { SnapshotsFor } from '../hooks/useQuotaHistory';
import styles from './QuotaLedger.module.scss';

export interface QuotaLedgerProps {
  entries: QuotaFileEntry[];
  /** Credentials per provider across every page, for the group card count. */
  providerCounts: Partial<Record<QuotaProviderType, number>>;
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  lastSeen: Record<string, number>;
  snapshotsFor: SnapshotsFor;
  lookbackMs: number;
  nowMs: number;
  canUseActions: boolean;
  resettingQuotaName: string | null;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
}

const fillClass = (remaining: number) =>
  remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
    ? styles.fillHigh
    : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
      ? styles.fillMedium
      : styles.fillLow;

/** The meter's burn rate, e.g. `0.8%/h`; the tooltip says what backs it. */
function MeterRate({ meter, rate }: { meter: QuotaMeterReading; rate: ResolvedRate }) {
  const { t } = useTranslation();
  if (!rate.ratePerHour || meter.remaining <= 0) return null;
  const source =
    rate.source === 'history'
      ? t('quota_management.forecast_rate_source_measured', {
          covered: formatCompactDuration(rate.coveredMs),
        })
      : t('quota_management.forecast_rate_source_window');
  return (
    <span className={styles.meterRate} title={source}>
      {formatRate(rate.ratePerHour)}/h
    </span>
  );
}

/* ---------- provider group card ---------- */

interface ProviderGroupProps {
  provider: QuotaProviderType;
  count: number;
  meters: QuotaMeterReading[][];
  resolvedTheme: ResolvedTheme;
}

function ProviderGroup({ provider, count, meters, resolvedTheme }: ProviderGroupProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Sum each limit across the group's loaded credentials, keyed by meter id.
  const totals = useMemo(() => {
    const byId = new Map<string, { meter: QuotaMeterReading; total: number; count: number }>();
    meters.flat().forEach((meter) => {
      const current = byId.get(meter.id);
      if (current) {
        current.total += meter.remaining;
        current.count += 1;
      } else {
        byId.set(meter.id, { meter, total: meter.remaining, count: 1 });
      }
    });
    return orderedMeters(Array.from(byId.values()).map((item) => item.meter)).map((meter) => ({
      meter,
      total: byId.get(meter.id)?.total ?? 0,
      count: byId.get(meter.id)?.count ?? 0,
    }));
  }, [meters]);

  // Collapsed: the model-scoped weekly limits (what the account total hides).
  const highlighted = totals.filter(
    ({ meter }) => !meter.primary && (meter.periodHours ?? 0) >= 24
  );
  const visible = expanded ? totals : highlighted.length > 0 ? highlighted : totals.slice(0, 1);
  const canToggle = totals.length > visible.length || expanded;

  return (
    <div className={styles.group}>
      <ProviderIcon provider={provider} resolvedTheme={resolvedTheme} size="sm" />
      <span className={styles.groupName}>{getTypeLabel(t, provider)}</span>
      <span className={styles.groupCount}>{t('quota_management.meta_credentials', { count })}</span>
      <div className={styles.groupLimits}>
        {visible.map(({ meter, total, count: reporting }) => (
          <span key={meter.id} className={styles.groupLimit}>
            {meterLabel(t, meter)}
            <strong>{formatPercent(total)}</strong>
            {/* Not every credential reports every limit; show what the total covers. */}
            <span className={styles.groupCapacity}>/ {formatPercent(reporting * 100)}</span>
          </span>
        ))}
      </div>
      {canToggle && (
        <button
          type="button"
          className={styles.groupToggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(
            expanded ? 'quota_management.ledger_hide_limits' : 'quota_management.ledger_show_limits'
          )}
        </button>
      )}
    </div>
  );
}

/* ---------- credential row ---------- */

interface LedgerRowProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  meters: QuotaMeterReading[];
  resolvedTheme: ResolvedTheme;
  lastSeenMs?: number;
  snapshotsFor: SnapshotsFor;
  lookbackMs: number;
  nowMs: number;
  canRefresh: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
}

function LedgerRow(props: LedgerRowProps) {
  const { entry, quota, meters, resolvedTheme, lastSeenMs, nowMs } = props;
  const { snapshotsFor, lookbackMs } = props;
  const { canRefresh, resetting, onRefresh, onReset } = props;
  const { t, i18n } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const status = quota?.status ?? 'idle';
  const claudeReset = useClaudeResetGrants(
    entry.file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || status === 'loading' || resetting,
    quota,
    onRefresh
  );

  const backAtMs = exhaustedUntilMs(meters, nowMs);
  const resetText = (meter: QuotaMeterReading) =>
    meter.resetAtMs && meter.resetAtMs > nowMs
      ? t('quota_management.ledger_resets', {
          duration: formatCompactDuration(meter.resetAtMs - nowMs),
          time: formatWeekdayTime(meter.resetAtMs, i18n.language),
        })
      : t('quota_management.ledger_no_reset');
  const name = stripCredentialExtension(getQuotaDisplayName(entry.file));
  const email = entry.file.email?.trim();
  // Files are usually named after the account; don't repeat the email then.
  const shownEmail = email && email !== stripCredentialExtension(entry.file.name) ? email : '';

  return (
    <div className={styles.row}>
      <div className={styles.identity}>
        <div className={styles.nameLine}>
          <ProviderIcon provider={entry.type} resolvedTheme={resolvedTheme} size="sm" />
          <PrivateValue className={styles.name} value={name} />
        </div>
        <div className={styles.metaLine}>
          <span>{getTypeLabel(t, entry.type)}</span>
          {backAtMs !== null ? (
            <span className={styles.alert}>
              {t('quota_management.ledger_back_in', {
                duration: formatCompactDuration(backAtMs - nowMs),
              })}
            </span>
          ) : status === 'error' ? (
            <span className={styles.alert}>{t('quota_management.ledger_read_failed')}</span>
          ) : shownEmail ? (
            <PrivateValue className={styles.email} value={shownEmail} />
          ) : null}
        </div>
        <div className={styles.metaLine}>
          {lastSeenMs
            ? t('quota_management.ledger_last_seen', {
                time: formatDateTime(lastSeenMs, i18n.language),
              })
            : t('quota_management.ledger_never_seen')}
        </div>
      </div>

      <div className={styles.meters}>
        {meters.length > 0 ? (
          orderedMeters(meters).map((meter) => {
            const rate = resolveMeterRate(
              meter,
              snapshotsFor(getQuotaCacheKey(entry.file), meter.id),
              nowMs,
              lookbackMs
            );
            return (
              <div
                key={meter.id}
                className={`${styles.meter} ${meter.remaining >= 100 ? styles.meterFull : ''}`}
              >
                <div className={styles.meterHead}>
                  <span className={styles.meterLabel} title={meterLabel(t, meter)}>
                    {meterLabel(t, meter)}
                  </span>
                  <span className={styles.meterValue}>{formatPercent(meter.remaining)}</span>
                </div>
                <div className={styles.track}>
                  <div
                    className={`${styles.fill} ${fillClass(meter.remaining)}`}
                    style={{ width: `${meter.remaining}%` }}
                  />
                </div>
                <div className={styles.meterReset}>
                  <span className={styles.meterResetText} title={resetText(meter)}>
                    {resetText(meter)}
                  </span>
                  <MeterRate meter={meter} rate={rate} />
                </div>
                {/* An exhausted window's "back in" is already on the status line. */}
                {meter.remaining > 0 && (
                  <QuotaPrediction meter={meter} nowMs={nowMs} rate={rate} withRate={false} wrap />
                )}
              </div>
            );
          })
        ) : status === 'error' ? (
          <p className={styles.error} role="alert">
            {resolveQuotaErrorMessage(
              t,
              quota?.errorStatus,
              quota?.error || t('common.unknown_error')
            )}
          </p>
        ) : status === 'loading' ? (
          <p className={styles.muted} aria-busy="true">
            {t(`${adapter.i18nPrefix}.loading`)}
          </p>
        ) : (
          <button type="button" className={styles.idle} onClick={onRefresh} disabled={!canRefresh}>
            {t(`${adapter.i18nPrefix}.idle`)}
          </button>
        )}
      </div>

      <div className={styles.side}>
        {entry.type === 'claude' && status === 'success' && (
          <span className={styles.resetsRemaining}>
            {t('claude_reset.remaining')} <strong>{claudeReset.count ?? '--'}</strong>
          </span>
        )}
        {status !== 'idle' && (
          <div className={styles.actions}>
            <QuotaEntryActions
              entry={entry}
              quota={quota}
              claudeReset={claudeReset}
              canRefresh={canRefresh}
              resetting={resetting}
              buttonClassName={styles.textButton}
              spinningClassName={styles.spinning}
              onRefresh={onRefresh}
              onReset={onReset}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- ledger ---------- */

export function QuotaLedger(props: QuotaLedgerProps) {
  const { entries, providerCounts, quotaFor, resolvedTheme, lastSeen, nowMs } = props;
  const { snapshotsFor, lookbackMs } = props;
  const { canUseActions, resettingQuotaName, onRefresh, onReset } = props;

  const groups = useMemo(() => {
    const byProvider = new Map<QuotaProviderType, QuotaFileEntry[]>();
    entries.forEach((entry) => {
      byProvider.set(entry.type, [...(byProvider.get(entry.type) ?? []), entry]);
    });
    return Array.from(byProvider.entries()).map(([provider, items]) => ({
      provider,
      items: items.map((entry) => ({
        entry,
        meters: readQuotaMeters(entry.type, quotaFor(entry)).map((meter) =>
          meterAsOf(meter, nowMs)
        ),
      })),
    }));
  }, [entries, nowMs, quotaFor]);

  return (
    <div className={styles.ledger}>
      {groups.map(({ provider, items }) => (
        <section key={provider} className={styles.section}>
          <ProviderGroup
            provider={provider}
            count={providerCounts[provider] ?? items.length}
            meters={items.map((item) => item.meters)}
            resolvedTheme={resolvedTheme}
          />
          {items.map(({ entry, meters }) => {
            const key = getQuotaCacheKey(entry.file);
            return (
              <LedgerRow
                key={`${entry.type}:${key}`}
                entry={entry}
                quota={quotaFor(entry)}
                meters={meters}
                resolvedTheme={resolvedTheme}
                lastSeenMs={lastSeen[key]}
                snapshotsFor={snapshotsFor}
                lookbackMs={lookbackMs}
                nowMs={nowMs}
                canRefresh={canUseActions && !entry.file.disabled}
                resetting={resettingQuotaName === key}
                onRefresh={() => onRefresh(entry)}
                onReset={() => onReset(entry)}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}
