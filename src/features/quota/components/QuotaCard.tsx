/**
 * Provider quota card: identity, loading/error state, quota body, and actions.
 * Claude observations remain visible while refreshing or after a failed read.
 */

import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ClaudeQuotaState, ResolvedTheme } from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { bindQuotaClasses } from '../types';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaFileEntry } from '../logic';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { ClaudeResetGrantDetails } from '../providers/claude/ClaudeResetGrantDetails';
import { hasClaudeUsageData } from '../providers/claude/data';
import { stripCredentialExtension } from '../display';
import { MeterDisplayContext, useMeterDisplay } from '../meterDisplay';
import { runsOutAtPace, windowBurn } from '../forecast/burnRate';
import { PrivateValue } from './PrivateValue';
import { meterAsOf, meterLabel, orderedMeters, readQuotaMeters } from '../forecast/quotaMeters';
import { QuotaEntryActions } from './QuotaEntryActions';
import { QuotaPrediction } from './QuotaPrediction';
import { resolveMeterRate } from '../forecast/forecastWindows';
import type { SnapshotsFor } from '../hooks/useQuotaHistory';
import bodyStyles from './QuotaBody.module.scss';
import styles from './QuotaCard.module.scss';

/** Bind the quota-page styles to the shared rendering contract. */
const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

export type QuotaCardProps = {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  resolvedTheme: ResolvedTheme;
  canRefresh: boolean;
  resetting: boolean;
  snapshotsFor: SnapshotsFor;
  lookbackMs: number;
  nowMs: number;
  /** Initial cascade delay; null disables entrance motion for later mounts. */
  entranceDelayMs?: number | null;
  onRefresh: () => void;
  onReset: () => void;
};

export function QuotaCard(props: QuotaCardProps) {
  const {
    entry,
    quota,
    resolvedTheme,
    canRefresh,
    resetting,
    snapshotsFor,
    lookbackMs,
    nowMs,
    entranceDelayMs,
    onRefresh,
    onReset,
  } = props;
  const { t } = useTranslation();
  const { mode } = useMeterDisplay();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const retainedClaudeUsage =
    entry.type === 'claude' && hasClaudeUsageData(quota as ClaudeQuotaState | undefined);
  const displayName = stripCredentialExtension(getQuotaDisplayName(file));

  // Capture the entrance delay only at mount, without a render-time ref read.
  const [mountEntranceDelayMs] = useState<number | null>(entranceDelayMs ?? null);
  const entranceStyle =
    mountEntranceDelayMs === null
      ? undefined
      : ({ '--card-delay': `${mountEntranceDelayMs}ms` } as CSSProperties);

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const providerType =
    entry.type === 'plugin'
      ? String(
          file.quotaProvider ?? file['quota_provider'] ?? file.provider ?? file.type ?? 'plugin'
        )
      : entry.type;
  const iconSrc = getAuthFileIcon(providerType, resolvedTheme);
  const typeLabel = getTypeLabel(t, providerType);
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  // Claude banked resets join the plan chip row; their expiry list follows it.
  const showClaudeReset = entry.type === 'claude' && status === 'success';
  const claudePlanItems = showClaudeReset ? (
    <span className={quotaClasses.codexPlanItem}>
      <span className={quotaClasses.codexPlanLabel}>{t('claude_reset.remaining')}</span>
      <span className={quotaClasses.codexPlanValue}>{claudeReset.count ?? '--'}</span>
    </span>
  ) : undefined;
  const claudeAfterPlan = showClaudeReset ? (
    <>
      <ClaudeResetGrantDetails grants={claudeReset.grants} classes={quotaClasses} />
      {claudeReset.message && (
        <div role="status" className={quotaClasses.codexResetCreditsError}>
          {t(`claude_reset.${claudeReset.message}`)}
        </div>
      )}
    </>
  ) : undefined;
  // "If you continue at this rate" for each window that has a known length.
  const predictedMeters = orderedMeters(
    readQuotaMeters(entry.type, quota).map((meter) => meterAsOf(meter, nowMs))
  ).filter(
    (meter) => meter.resetAtMs !== null && meter.periodHours !== null && meter.remaining < 100
  );
  const meterRates = predictedMeters.map((meter) => ({
    meter,
    rate: resolveMeterRate(
      meter,
      snapshotsFor(getQuotaCacheKey(file), meter.id),
      nowMs,
      lookbackMs
    ),
  }));
  // Bars of windows that empty before their reset at this pace turn red.
  const atPace = new Set(
    meterRates
      .filter(({ meter, rate }) => runsOutAtPace(windowBurn(meter, nowMs, rate.ratePerHour)))
      .map(({ meter }) => meter.id)
  );
  const meterDisplay = { mode, atPace };

  return (
    <article
      className={`${styles.card} ${mountEntranceDelayMs === null ? '' : styles.cardEnter}`}
      style={entranceStyle}
    >
      <header className={styles.head}>
        <span
          className={styles.iconWrap}
          title={typeLabel}
          style={
            isThemeSurfaceIconProvider(providerType)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className={styles.icon} />
          ) : (
            <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <PrivateValue className={styles.fileName} value={displayName} />
      </header>

      <MeterDisplayContext.Provider value={meterDisplay}>
        <div className={styles.body}>
          {status === 'idle' ? (
            <button
              type="button"
              className={styles.idleBody}
              onClick={onRefresh}
              disabled={!canRefresh}
            >
              <IconRefreshCw size={15} aria-hidden="true" className={styles.idleGlyph} />
              <span className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</span>
            </button>
          ) : loading && !retainedClaudeUsage ? (
            <div className={styles.skeleton} aria-busy="true">
              <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
              {[0, 1].map((row) => (
                <div key={row} className={styles.skeletonRow} aria-hidden="true">
                  <span className={styles.skeletonLabel} />
                  <span className={styles.skeletonTrack} />
                </div>
              ))}
            </div>
          ) : status === 'error' ? (
            <div className={styles.errorStrip} role="alert">
              {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
            </div>
          ) : quota && !retainedClaudeUsage ? (
            <adapter.Body
              quota={quota}
              classes={quotaClasses}
              planItems={claudePlanItems}
              afterPlan={claudeAfterPlan}
            />
          ) : !retainedClaudeUsage ? (
            <div className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</div>
          ) : null}
          {loading && retainedClaudeUsage && (
            <div role="status" aria-busy="true" className={quotaClasses.quotaMessage}>
              {t(`${adapter.i18nPrefix}.loading`)}
            </div>
          )}
          {retainedClaudeUsage && quota && (
            <adapter.Body
              quota={quota}
              classes={quotaClasses}
              planItems={claudePlanItems}
              afterPlan={claudeAfterPlan}
            />
          )}
        </div>
      </MeterDisplayContext.Provider>

      {predictedMeters.length > 0 && (
        <div className={styles.predictions}>
          {meterRates.map(({ meter, rate }) => (
            <div key={meter.id} className={styles.predictionRow}>
              <span className={styles.predictionLabel}>{meterLabel(t, meter)}</span>
              <QuotaPrediction meter={meter} nowMs={nowMs} rate={rate} />
            </div>
          ))}
        </div>
      )}

      {status !== 'idle' && (
        <footer className={styles.actionRow}>
          <QuotaEntryActions
            entry={entry}
            quota={quota}
            claudeReset={claudeReset}
            canRefresh={canRefresh}
            resetting={resetting}
            buttonClassName={styles.actionPill}
            spinningClassName={styles.spinning}
            onRefresh={onRefresh}
            onReset={onReset}
          />
        </footer>
      )}
    </article>
  );
}
