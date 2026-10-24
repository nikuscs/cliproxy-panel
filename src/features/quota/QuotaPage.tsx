/**
 * 额度查询页：提供商 tabs + 统一卡网格。
 *
 * 保留的行为契约（重设计不改）：
 * - 现有提供商保持点击加载；Devin 首次可见时主动查询一次，不轮询；
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaCard } from './components/QuotaCard';
import { QuotaTimeline } from './components/QuotaTimeline';
import { QuotaForecast } from './components/QuotaForecast';
import { QuotaLedger } from './components/QuotaLedger';
import {
  CARD_ENTRANCE_BUDGET_MS,
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  QUOTA_STALE_MS,
  QUOTA_VIEW_MODES,
  type QuotaSortMode,
  type QuotaTabId,
  type QuotaViewMode,
} from './constants';
import {
  buildTabCounts,
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import { nextRecoveryMs } from './resetSchedule';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useDevinQuotaAutoLoad } from './providers/devin/useDevinQuotaAutoLoad';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { stripCredentialExtension } from './display';
import { PrivacyContext } from './privacy';
import { MeterDisplayContext, QUOTA_DISPLAY_MODES, type QuotaDisplayMode } from './meterDisplay';
import { quotaObservedAt, useQuotaCache } from './hooks/useQuotaCache';
import { useQuotaHistory } from './hooks/useQuotaHistory';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import {
  readQuotaPreferences,
  readQuotaUiState,
  writeQuotaPreferences,
  writeQuotaUiState,
  type QuotaPreferences,
} from './uiState';
import styles from './QuotaPage.module.scss';

const SKELETON_CARD_COUNT = 6;
/** Background re-read of the credential list (passive quota snapshots). */
const FILES_POLL_MS = 2 * 60_000;
/** Slower re-read while the tab is in the background (browsers throttle timers anyway). */
const FILES_POLL_HIDDEN_MS = 5 * 60_000;
/** Chart heights: one provider gets room; All stacks several compact ones. */
const PROVIDER_TAB_CHART_HEIGHT = 160;
const ALL_TAB_CHART_HEIGHT = 112;

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const connection = useAuthStore((state) => state.apiBase);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<QuotaTabId>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [preferences, setPreferences] = useState<QuotaPreferences>(readQuotaPreferences);
  const updatePreferences = useCallback((patch: Partial<QuotaPreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
    writeQuotaPreferences(patch);
  }, []);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 页头 + tabs 的入场级联（标题 → meta → 动作 → tabs，级差 70ms）
  const revealRef = useRevealGroup<HTMLDivElement>();

  // Focus rings are for keyboard users: a mouse or touch press must not leave
  // a box around the pressed tab or button (Chrome can still match
  // :focus-visible on click after recent typing).
  const [inputMode, setInputMode] = useState<'pointer' | 'keyboard'>('pointer');
  useEffect(() => {
    const onPointer = () => setInputMode('pointer');
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab' || event.key.startsWith('Arrow')) setInputMode('keyboard');
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  /* ---------- 后台轮询凭证列表 ----------
   * Re-read the credential list every FILES_POLL_MS while the page is
   * visible, and every FILES_POLL_HIDDEN_MS while the tab is in the
   * background (the user is typically working in a terminal then, which is
   * exactly the usage worth recording). The list carries the server's passive
   * quota snapshot, so no upstream provider is called. An explicit load in
   * flight or started meanwhile always wins. */

  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  const lastPollRef = useRef(0);
  const pollFiles = useCallback(async () => {
    if (connectionStatus !== 'connected' || loadingRef.current) return;
    const requestId = listRequestRef.current;
    lastPollRef.current = Date.now();
    try {
      const data = await authFilesApi.list();
      if (
        requestId !== listRequestRef.current ||
        sessionGeneration !== useQuotaStore.getState().cacheGeneration
      ) {
        return;
      }
      setFiles(data?.files || []);
    } catch {
      // Quiet by design: the next poll or an explicit refresh reports errors.
    }
  }, [connectionStatus, sessionGeneration]);

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    const pollIfDue = () => {
      const interval =
        document.visibilityState === 'visible' ? FILES_POLL_MS : FILES_POLL_HIDDEN_MS;
      if (Date.now() - lastPollRef.current >= interval - 5_000) void pollFiles();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') pollIfDue();
    };
    const timer = window.setInterval(pollIfDue, FILES_POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [connectionStatus, pollFiles]);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ----------
   * 排在归类/排序之前：「最快恢复优先」要读它算排序键。 */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        plugin: pluginQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    ]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // 只在「最快恢复优先」下订阅分钟时钟。默认序下不门控的话，pageItems 每分钟
  // 换一次身份，会反复空转下面那个「刷新全部」的 loading 下降沿 effect。
  const tick = useNow(sortMode !== 'default');
  const sortNow = sortMode === 'default' ? 0 : tick;

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);

  // Tabs for providers with credentials only. Until this session's list has
  // loaded, show the providers seen last time so tabs don't flicker in.
  const filesReady = filesGeneration === sessionGeneration;
  const tabIds = useMemo(
    () => [
      'all',
      ...QUOTA_TAB_ORDER.filter((type) =>
        filesReady ? (tabCounts[type] ?? 0) > 0 : preferences.knownProviders.includes(type)
      ),
    ],
    [filesReady, preferences.knownProviders, tabCounts]
  );
  const filteredEntries = useMemo(
    () => filterEntriesBySearch(filterEntriesByTab(entries, tab), search),
    [entries, tab, search]
  );
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // 排序在分页之前：否则「最快恢复」只在当前页内成立。
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  // Remember which providers have credentials; leave a tab that no longer
  // has any (deleted last account, or a stale saved tab after a reload).
  const providersWithCredentials = useMemo(
    () => QUOTA_TAB_ORDER.filter((type) => (tabCounts[type] ?? 0) > 0),
    [tabCounts]
  );
  useEffect(() => {
    if (!filesReady || loading || error) return;
    if (providersWithCredentials.join() !== preferences.knownProviders.join()) {
      updatePreferences({ knownProviders: providersWithCredentials });
    }
    if (tab !== 'all' && !providersWithCredentials.includes(tab)) {
      setTab('all');
      setPage(1);
      writeQuotaUiState({ tab: 'all' });
    }
  }, [
    error,
    filesReady,
    loading,
    preferences.knownProviders,
    providersWithCredentials,
    tab,
    updatePreferences,
  ]);

  const handleTabChange = useCallback((next: string) => {
    setTab(next as QuotaTabId);
    setPage(1);
    writeQuotaUiState({ tab: next as QuotaTabId });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  const displayOptions = useMemo(
    () =>
      QUOTA_DISPLAY_MODES.map((mode) => ({
        value: mode,
        label: t(`quota_management.display_${mode}`),
      })),
    [t]
  );
  const meterDisplay = useMemo(
    () => ({ mode: preferences.displayMode, atPace: new Set<string>() }),
    [preferences.displayMode]
  );

  const viewOptions = useMemo(
    () =>
      QUOTA_VIEW_MODES.map((mode) => ({ value: mode, label: t(`quota_management.view_${mode}`) })),
    [t]
  );

  /* ---------- 缓存、历史与预测 ----------
   * Rows hydrate from the server's passive snapshot or the panel's own cache
   * before any live read; the panel records its own history (the backend
   * keeps none). */

  const clockNow = useNow();
  const {
    lastSeen,
    revision: historyRevision,
    hydrated,
  } = useQuotaCache(entries, getQuota, connection);
  const [seedRevision, setSeedRevision] = useState(0);
  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_QUOTA_MOCK !== '1' || !connection) return;
    void import('./dev/seedHistory')
      .then(({ seedMockHistory }) => seedMockHistory(connection))
      .then(() => setSeedRevision((value) => value + 1));
  }, [connection]);

  // Recorded history for every provider with credentials, shared by the
  // forecast panels, ledger rows and cards (one rate rule everywhere).
  const {
    historyFor,
    snapshotsFor,
    loaded: historyLoaded,
  } = useQuotaHistory(
    connection,
    providersWithCredentials,
    clockNow -
      Math.max(preferences.forecastRangeDays * DAY_MS, preferences.forecastLookbackHours * HOUR_MS),
    historyRevision + seedRevision
  );

  // One forecast per provider: the selected tab, or every provider with
  // credentials on All. Providers are never summed together.
  const forecastGroups = useMemo(
    () =>
      (tab === 'all' ? QUOTA_TAB_ORDER : [tab])
        .map((provider) => ({ provider, entries: filterEntriesByTab(entries, provider) }))
        .filter((group) => group.entries.length > 0),
    [entries, tab]
  );
  const viewMode: QuotaViewMode = tab === 'all' ? preferences.allViewMode : preferences.viewMode;
  const handleViewModeChange = (next: string) =>
    updatePreferences(
      tab === 'all' ? { allViewMode: next as QuotaViewMode } : { viewMode: next as QuotaViewMode }
    );
  const toggleForecast = (provider: QuotaProviderType, collapsed: boolean) =>
    updatePreferences({
      collapsedForecasts: collapsed
        ? [...preferences.collapsedForecasts.filter((id) => id !== provider), provider]
        : preferences.collapsedForecasts.filter((id) => id !== provider),
    });
  const providerCounts = useMemo(() => {
    const counts: Partial<Record<QuotaProviderType, number>> = {};
    sortedEntries.forEach((entry) => {
      counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    });
    return counts;
  }, [sortedEntries]);

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    entries.forEach((entry) => {
      const status = quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status;
      if (status === 'success') loaded += 1;
      else if (status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [entries, quotaByType]);

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(
    disableControls,
    preferences.showEmails
  );

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // 刷新全部：先重取文件列表，待其落定（loading 下降沿）再批量拉当前页额度
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota(pageItems, { keepExisting: true });
    }
  }, [disableControls, error, filesGeneration, loading, loadQuota, pageItems, sessionGeneration]);

  // Page entry: once per session, refresh in the background whatever on this
  // page is missing or older than QUOTA_STALE_MS. Cached rows stay on screen
  // and update in place. Retried if another batch (Devin auto-load) holds the
  // loader.
  const autoRefreshedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hydrated || loading || batchLoading || Boolean(error) || disableControls) return;
    if (filesGeneration !== sessionGeneration || autoRefreshedRef.current === sessionGeneration) {
      return;
    }
    autoRefreshedRef.current = sessionGeneration;
    const now = Date.now();
    const stale = pageItems.filter((entry) => {
      const quota = getQuota(entry);
      if (quota?.status === 'loading') return false;
      const observedAt = quotaObservedAt(quota);
      return observedAt === null || now - observedAt > QUOTA_STALE_MS;
    });
    void loadQuota(stale, { keepExisting: true }).then((started) => {
      if (!started && stale.length > 0) autoRefreshedRef.current = null;
    });
  }, [
    batchLoading,
    disableControls,
    error,
    filesGeneration,
    getQuota,
    hydrated,
    loadQuota,
    loading,
    pageItems,
    sessionGeneration,
  ]);

  useDevinQuotaAutoLoad(
    pageItems,
    disableControls ||
      loading ||
      batchLoading ||
      Boolean(error) ||
      filesGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* ---------- 首屏卡片一次性级联入场 ----------
   * 首批数据渲染后立即翻转 cardsAnimated；已挂载的卡片在挂载时捕获过自己的
   * 延迟（QuotaCard 内 useState 初始化），后续切 tab/翻页/刷新新挂载的卡片
   * 拿到 null —— 不重播。 */

  const [cardsAnimated, setCardsAnimated] = useState(false);
  const enableCardEntrance = !cardsAnimated && !loading && pageItems.length > 0;
  useEffect(() => {
    if (enableCardEntrance) {
      setCardsAnimated(true);
    }
  }, [enableCardEntrance]);
  const cardEntranceDelay = (index: number): number | null => {
    if (!enableCardEntrance) return null;
    if (pageItems.length <= 1) return 0;
    return Math.round((index / (pageItems.length - 1)) * CARD_ENTRANCE_BUDGET_MS);
  };

  // Timeline lanes use the same label as rows and cards (no extension); it renders blurred.
  const timelineNameFor = stripCredentialExtension;

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && filteredEntries.length === 0;

  return (
    // Private values (emails, account names) blur unless revealed.
    <PrivacyContext.Provider value={preferences.showEmails}>
      <MeterDisplayContext.Provider value={meterDisplay}>
        <div className={styles.page} ref={revealRef} data-input={inputMode}>
          <QuotaHeader
            totalCount={entries.length}
            loadedCount={loadedCount}
            attentionCount={attentionCount}
            refreshing={loading || batchLoading}
            disableControls={disableControls}
            showEmails={preferences.showEmails}
            onToggleEmails={() => updatePreferences({ showEmails: !preferences.showEmails })}
            onRefreshAll={handleRefreshAll}
          />

          <section className={styles.workbench}>
            {/* 提供商导航与搜索工具栏分层，避免不同控件争夺视觉焦点。 */}
            <div className={styles.tabsRow} data-reveal>
              <ProviderTabs
                types={tabIds}
                counts={tabCounts}
                active={tab}
                resolvedTheme={resolvedTheme}
                onChange={handleTabChange}
              />
            </div>

            {/* A placeholder until cached quota and recorded history are both in. */}
            {!loading && (!hydrated || !historyLoaded) && forecastGroups.length > 0 && (
              <div className={styles.forecasts} aria-busy="true">
                {forecastGroups.map((group) => (
                  <Skeleton
                    key={group.provider}
                    height={
                      tab === 'all' ? ALL_TAB_CHART_HEIGHT + 40 : PROVIDER_TAB_CHART_HEIGHT + 150
                    }
                    rounded={14}
                  />
                ))}
              </div>
            )}

            {!loading && hydrated && historyLoaded && forecastGroups.length > 0 && (
              <div className={styles.forecasts}>
                {forecastGroups.map((group) => (
                  <QuotaForecast
                    key={group.provider}
                    provider={group.provider}
                    entries={group.entries}
                    quotaFor={getQuota}
                    history={historyFor(group.provider)}
                    snapshotsFor={snapshotsFor}
                    nowMs={clockNow}
                    resolvedTheme={resolvedTheme}
                    layout={tab === 'all' ? 'split' : 'stacked'}
                    chartHeight={tab === 'all' ? ALL_TAB_CHART_HEIGHT : PROVIDER_TAB_CHART_HEIGHT}
                    rangeDays={preferences.forecastRangeDays}
                    lookbackHours={preferences.forecastLookbackHours}
                    collapsed={preferences.collapsedForecasts.includes(group.provider)}
                    onRangeDaysChange={(forecastRangeDays) =>
                      updatePreferences({ forecastRangeDays })
                    }
                    onLookbackHoursChange={(forecastLookbackHours) =>
                      updatePreferences({ forecastLookbackHours })
                    }
                    onCollapsedChange={(collapsed) => toggleForecast(group.provider, collapsed)}
                  />
                ))}
              </div>
            )}

            <div className={styles.toolbar}>
              <div className={styles.search}>
                <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  className={styles.searchInput}
                  type="search"
                  value={search}
                  onChange={(event) => handleSearchChange(event.target.value)}
                  placeholder={t('quota_management.search_placeholder')}
                  aria-label={t('quota_management.search_label')}
                />
                {search && (
                  <button
                    type="button"
                    className={styles.clearSearch}
                    aria-label={t('quota_management.search_clear')}
                    title={t('quota_management.search_clear')}
                    onClick={() => {
                      handleSearchChange('');
                      searchInputRef.current?.focus();
                    }}
                  >
                    <IconX size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className={styles.sort}>
                <Select
                  value={preferences.displayMode}
                  options={displayOptions}
                  onChange={(value) =>
                    updatePreferences({ displayMode: value as QuotaDisplayMode })
                  }
                  ariaLabel={t('quota_management.display_label')}
                  className={styles.quietSelect}
                  menuClassName={styles.quietMenu}
                  fullWidth={false}
                  size="sm"
                />
                <Select
                  value={viewMode}
                  options={viewOptions}
                  onChange={handleViewModeChange}
                  ariaLabel={t('quota_management.view_label')}
                  className={styles.quietSelect}
                  menuClassName={styles.quietMenu}
                  fullWidth={false}
                  size="sm"
                />
                <Select
                  value={sortMode}
                  options={sortOptions}
                  onChange={handleSortModeChange}
                  ariaLabel={t('quota_management.sort_label')}
                  className={styles.quietSelect}
                  menuClassName={styles.quietMenu}
                  fullWidth={false}
                  size="sm"
                />
              </div>
            </div>

            {error && (
              <div className={styles.errorBanner} role="alert">
                {error}
              </div>
            )}

            {loading || !hydrated ? (
              <div className={styles.grid} aria-hidden="true">
                {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
                  <Skeleton key={index} height={168} rounded={14} />
                ))}
              </div>
            ) : isEmpty ? (
              <EmptyState
                title={
                  search.trim()
                    ? t('quota_management.search_empty_title')
                    : tab === 'all'
                      ? t('quota_management.empty_title')
                      : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
                }
                description={
                  search.trim()
                    ? t('quota_management.search_empty_desc')
                    : tab === 'all'
                      ? t('quota_management.empty_desc')
                      : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
                }
                action={
                  search.trim() ? (
                    <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                      {t('quota_management.search_clear')}
                    </Button>
                  ) : tab === 'all' ? undefined : (
                    <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                      {t('auth_files.filter_all')}
                    </Button>
                  )
                }
              />
            ) : viewMode === 'ledger' ? (
              <QuotaLedger
                entries={pageItems}
                providerCounts={providerCounts}
                quotaFor={getQuota}
                resolvedTheme={resolvedTheme}
                lastSeen={lastSeen}
                snapshotsFor={snapshotsFor}
                lookbackMs={preferences.forecastLookbackHours * HOUR_MS}
                nowMs={clockNow}
                canUseActions={canUseActions}
                resettingQuotaName={resettingQuotaName}
                onRefresh={(entry) => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                onReset={(entry) => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
              />
            ) : (
              <div className={styles.grid}>
                {pageItems.map((entry, index) => (
                  <QuotaCard
                    key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
                    entry={entry}
                    quota={getQuota(entry)}
                    resolvedTheme={resolvedTheme}
                    canRefresh={canUseActions && !entry.file.disabled}
                    resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
                    snapshotsFor={snapshotsFor}
                    lookbackMs={preferences.forecastLookbackHours * HOUR_MS}
                    nowMs={clockNow}
                    entranceDelayMs={cardEntranceDelay(index)}
                    onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                    onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                  />
                ))}
              </div>
            )}

            {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                >
                  {t('auth_files.pagination_prev')}
                </Button>
                <div className={styles.pageInfo}>
                  {t('auth_files.pagination_info', {
                    current: currentPage,
                    total: totalPages,
                    count: filteredEntries.length,
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {t('auth_files.pagination_next')}
                </Button>
              </div>
            )}

            {/* 时间线只比较当前页凭证，避免大量凭证一次性生成无界泳道。 */}
            <QuotaTimeline
              entries={pageItems}
              quotaFor={getQuota}
              displayNameFor={timelineNameFor}
              resolvedTheme={resolvedTheme}
            />
          </section>
        </div>
      </MeterDisplayContext.Provider>
    </PrivacyContext.Provider>
  );
}
