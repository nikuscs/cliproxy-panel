/**
 * Per-credential quota actions shared by the card grid and the ledger rows:
 * Claude banked reset, provider reset (Codex), and refresh.
 */

import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import type { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';

export interface QuotaEntryActionsProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  claudeReset: ReturnType<typeof useClaudeResetGrants>;
  canRefresh: boolean;
  resetting: boolean;
  buttonClassName: string;
  spinningClassName: string;
  onRefresh: () => void;
  onReset: () => void;
}

export function QuotaEntryActions(props: QuotaEntryActionsProps) {
  const {
    entry,
    quota,
    claudeReset,
    canRefresh,
    resetting,
    buttonClassName,
    spinningClassName,
    onRefresh,
    onReset,
  } = props;
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const loading = quota?.status === 'loading';
  const showReset =
    quota?.status === 'success' &&
    Boolean(adapter.resetQuota) &&
    Boolean(adapter.canResetQuota?.(quota));

  return (
    <>
      {entry.type === 'claude' && (
        <button
          type="button"
          className={buttonClassName}
          disabled={claudeReset.blocked}
          onClick={claudeReset.confirm}
          title={t(`claude_reset.${claudeReset.buttonLabel}`)}
        >
          <IconRefreshCw size={13} className={claudeReset.busy ? spinningClassName : undefined} />
          {t(`claude_reset.${claudeReset.buttonLabel}`)}
        </button>
      )}
      {showReset && (
        <button
          type="button"
          className={buttonClassName}
          onClick={onReset}
          disabled={!canRefresh || loading || resetting}
          title={t('codex_quota.reset_button')}
        >
          <IconRefreshCw size={13} className={resetting ? spinningClassName : undefined} />
          {t('codex_quota.reset_button')}
        </button>
      )}
      <button
        type="button"
        className={buttonClassName}
        onClick={onRefresh}
        disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
        title={t('auth_files.quota_refresh_hint')}
      >
        <IconRefreshCw size={13} className={loading ? spinningClassName : undefined} />
        {t('auth_files.quota_refresh_single')}
      </button>
    </>
  );
}
