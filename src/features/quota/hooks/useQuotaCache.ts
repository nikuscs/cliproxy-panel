/**
 * Keeps the quota page populated without waiting for a live read.
 *
 * Hydrate: a credential with no state yet gets the newest of
 *  1. the server's passive snapshot in the auth-files list (Claude, Codex), and
 *  2. the last successful state the panel stored in IndexedDB (any provider).
 * A newer passive snapshot also replaces an older state already on screen.
 *
 * Record: every successful state the page sees (live fetch or passive) is
 * written once to the history snapshots and the latest-state store, keyed by
 * its observation time, so a reload or a repeated snapshot never duplicates.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { passiveQuotaFor } from '../forecast/passiveQuota';
import { readQuotaMeters } from '../forecast/quotaMeters';
import {
  readLatestQuota,
  recordQuotaSnapshots,
  saveLatestQuota,
  type LatestQuota,
  type QuotaSnapshot,
} from '../forecast/quotaHistory';

/** When each state on screen was observed upstream. Module-level so remounts keep it. */
const observedAtByState = new WeakMap<object, number>();
const processedStates = new WeakSet<object>();
/** Readings this close to the last stored one are the same read. */
const DUPLICATE_WINDOW_MS = 30_000;

/** Newest persisted observation per `${connection}|${credentialId}`. */
const persistedAt = new Map<string, number>();

export const quotaObservedAt = (state: QuotaCardState | undefined): number | null =>
  (state && observedAtByState.get(state)) ?? null;

const observationTime = (state: QuotaCardState) => {
  const known = observedAtByState.get(state);
  if (known) return known;
  const observedAt = (state as { observedAt?: string | null }).observedAt;
  const parsed = observedAt ? Date.parse(observedAt) : NaN;
  const ms = Number.isFinite(parsed) ? parsed : Date.now();
  observedAtByState.set(state, ms);
  return ms;
};

interface WindowsState {
  windows?: { id: string }[];
  observedAt?: string | null;
}

/**
 * Newer passive windows over an older full state: the signals carry only the
 * account windows (5-hour, 7-day), so model and extra windows from the last
 * live read are kept.
 */
function mergePassive(current: QuotaCardState, passive: QuotaCardState): QuotaCardState {
  const currentWindows = (current as WindowsState).windows ?? [];
  const passiveWindows = (passive as WindowsState).windows ?? [];
  const byId = new Map(passiveWindows.map((window) => [window.id, window]));
  const windows = [
    ...currentWindows.map((window) => byId.get(window.id) ?? window),
    ...passiveWindows.filter((window) => !currentWindows.some((item) => item.id === window.id)),
  ];
  const observedAt = (passive as WindowsState).observedAt;
  return {
    ...current,
    windows,
    ...(observedAt ? { observedAt } : {}),
  } as QuotaCardState;
}

export function useQuotaCache(
  entries: QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  connection: string
) {
  const { t } = useTranslation();
  const [latest, setLatest] = useState<Record<string, LatestQuota> | null>(null);
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});
  /** Bumped after each write so history readers can reload. */
  const [revision, setRevision] = useState(0);
  /** The entry list whose hydration has been committed (readers wait for it). */
  const [hydratedEntries, setHydratedEntries] = useState<QuotaFileEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLatest(null);
    setHydratedEntries(null);
    void readLatestQuota(connection).then((records) => {
      if (cancelled) return;
      Object.values(records).forEach((record) => {
        const key = `${connection}|${record.credentialId}`;
        persistedAt.set(key, Math.max(persistedAt.get(key) ?? 0, record.ts));
      });
      setLastSeen((current) => ({
        ...Object.fromEntries(Object.values(records).map((r) => [r.credentialId, r.ts])),
        ...current,
      }));
      setLatest(records);
    });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  /* ---------- hydrate ---------- */

  useEffect(() => {
    if (!latest) return;
    const generation = captureQuotaCacheGeneration();
    const updates = new Map<QuotaProviderType, Record<string, QuotaCardState>>();

    entries.forEach((entry) => {
      const key = getQuotaCacheKey(entry.file);
      const current = quotaFor(entry);
      if (current?.status === 'loading') return;

      const passive = passiveQuotaFor(entry.type, entry.file, t);
      const cached = latest[key]?.provider === entry.type ? latest[key] : undefined;
      // An error counts from when it was first seen, so only traffic observed
      // after the failure replaces it (the error stays visible until then).
      const currentAt = current && current.status !== 'idle' ? observationTime(current) : 0;

      let next: { state: QuotaCardState; observedAtMs: number } | null = null;
      // A failed live read must not block the server's passive snapshot
      // for good: otherwise a credential whose usage endpoint errors never
      // records history.
      if (passive && passive.observedAtMs > currentAt) {
        next =
          current?.status === 'success'
            ? { state: mergePassive(current, passive.state), observedAtMs: passive.observedAtMs }
            : passive;
      }
      if (!current || current.status === 'idle') {
        if (cached && (!next || cached.ts > next.observedAtMs)) {
          next = { state: cached.state, observedAtMs: cached.ts };
        }
      }
      if (!next) return;

      observedAtByState.set(next.state, next.observedAtMs);
      const group = updates.get(entry.type) ?? {};
      group[key] = next.state;
      updates.set(entry.type, group);
    });

    updates.forEach((states, type) => {
      commitIfQuotaCacheCurrent(generation, () =>
        getQuotaSetter(QUOTA_ADAPTERS[type])((prev) => ({ ...prev, ...states }))
      );
    });
    setHydratedEntries(entries);
  }, [entries, latest, quotaFor, t]);

  /* ---------- record ---------- */

  useEffect(() => {
    const snapshots: QuotaSnapshot[] = [];
    const records: LatestQuota[] = [];
    const seen: Record<string, number> = {};

    entries.forEach((entry) => {
      const state = quotaFor(entry);
      if (!state || state.status !== 'success' || processedStates.has(state)) return;
      processedStates.add(state);

      const credentialId = getQuotaCacheKey(entry.file);
      const ts = observationTime(state);
      const persistKey = `${connection}|${credentialId}`;
      seen[credentialId] = ts;
      // Older or same reading, or the background enrichment of a read just
      // stored (a second state object seconds later): nothing new to record.
      if (ts <= (persistedAt.get(persistKey) ?? 0) + DUPLICATE_WINDOW_MS) return;
      persistedAt.set(persistKey, ts);

      records.push({ connection, credentialId, provider: entry.type, ts, state });
      readQuotaMeters(entry.type, state).forEach((meter) =>
        snapshots.push({
          connection,
          ts,
          credentialId,
          provider: entry.type,
          window: meter.id,
          remaining: meter.remaining,
          resetAtMs: meter.resetAtMs,
          primary: meter.primary,
        })
      );
    });

    if (Object.keys(seen).length === 0) return;
    setLastSeen((current) => ({ ...current, ...seen }));
    if (records.length === 0) return;
    void Promise.all([saveLatestQuota(records), recordQuotaSnapshots(snapshots)]).then(() =>
      setRevision((value) => value + 1)
    );
  }, [connection, entries, quotaFor]);

  return { lastSeen, revision, hydrated: latest !== null && hydratedEntries === entries };
}
