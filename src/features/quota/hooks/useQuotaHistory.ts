/**
 * Recorded quota history for the providers on screen, shared by the forecast
 * panels, the ledger rows and the cards so every rate comes from the same
 * readings. Reloads after each recorded write (`revision`). `loaded` turns
 * true once the first read for these providers is in, so the forecast never
 * draws an empty chart that fills a moment later.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MINUTE_MS } from '@/utils/time/durations';
import type { QuotaProviderType } from '../providers/types';
import { readQuotaHistory, type QuotaSnapshot } from '../forecast/quotaHistory';

/** Snap the start so the read doesn't repeat every minute as the clock moves. */
const SINCE_STEP_MS = 10 * MINUTE_MS;

export function useQuotaHistory(
  connection: string,
  providers: QuotaProviderType[],
  sinceMs: number,
  revision: number
) {
  const [history, setHistory] = useState<Partial<Record<QuotaProviderType, QuotaSnapshot[]>>>({});
  const providerKey = providers.join(',');
  const readKey = `${connection}|${providerKey}`;
  /** The connection and providers the current `history` was read for. */
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const since = Math.floor(sinceMs / SINCE_STEP_MS) * SINCE_STEP_MS;

  useEffect(() => {
    let cancelled = false;
    const list = providerKey ? (providerKey.split(',') as QuotaProviderType[]) : [];
    void Promise.all(list.map((provider) => readQuotaHistory(connection, provider, since))).then(
      (results) => {
        if (cancelled) return;
        setHistory(Object.fromEntries(list.map((provider, index) => [provider, results[index]])));
        setLoadedKey(`${connection}|${list.join(',')}`);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [connection, providerKey, since, revision]);

  const byMeter = useMemo(() => {
    const index = new Map<string, QuotaSnapshot[]>();
    Object.values(history).forEach((snapshots) =>
      snapshots?.forEach((snapshot) => {
        const key = `${snapshot.credentialId}|${snapshot.window}`;
        const list = index.get(key);
        if (list) list.push(snapshot);
        else index.set(key, [snapshot]);
      })
    );
    return index;
  }, [history]);

  const historyFor = useCallback(
    (provider: QuotaProviderType) => history[provider] ?? [],
    [history]
  );
  const snapshotsFor = useCallback(
    (credentialId: string, windowId: string) => byMeter.get(`${credentialId}|${windowId}`) ?? [],
    [byMeter]
  );

  return { historyFor, snapshotsFor, loaded: loadedKey === readKey };
}

export type SnapshotsFor = ReturnType<typeof useQuotaHistory>['snapshotsFor'];
