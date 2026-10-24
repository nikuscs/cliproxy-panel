/**
 * Recorded quota history for the providers on screen, shared by the forecast
 * panels, the ledger rows and the cards so every rate comes from the same
 * readings. Reloads after each recorded write (`revision`). `loaded` turns
 * true once the first read for these providers is in, so the forecast never
 * draws an empty chart that fills a moment later.
 *
 * When the backend has the `quota-history` plugin, its server-side readings
 * join the browser's own: they cover the hours no tab was open. They are read
 * again whenever the start moves (every SINCE_STEP_MS), and a backend without
 * the plugin is not asked again this session.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { quotaHistoryApi, type ServerQuotaReading } from '@/services/api';
import { MINUTE_MS } from '@/utils/time/durations';
import type { QuotaProviderType } from '../providers/types';
import { readQuotaHistory, type QuotaSnapshot } from '../forecast/quotaHistory';
import { isPrimaryWindow } from '../forecast/quotaMeters';

/** Backends that answered without the plugin; not asked again this session. */
const withoutPlugin = new Set<string>();

const toSnapshot = (connection: string, reading: ServerQuotaReading): QuotaSnapshot => ({
  connection,
  ts: reading.ts,
  credentialId: reading.credential,
  provider: reading.provider as QuotaProviderType,
  window: reading.window,
  remaining: reading.remaining,
  resetAtMs: reading.resetAtMs,
  primary: isPrimaryWindow(reading.provider as QuotaProviderType, reading.window),
});

/** Snap the start so the read doesn't repeat every minute as the clock moves. */
const SINCE_STEP_MS = 10 * MINUTE_MS;

export function useQuotaHistory(
  connection: string,
  providers: QuotaProviderType[],
  sinceMs: number,
  revision: number
) {
  const [history, setHistory] = useState<Partial<Record<QuotaProviderType, QuotaSnapshot[]>>>({});
  const [server, setServer] = useState<QuotaSnapshot[]>([]);
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

  useEffect(() => {
    let cancelled = false;
    if (!connection || withoutPlugin.has(connection)) {
      setServer([]);
      return;
    }
    quotaHistoryApi
      .readings(connection, since)
      .then((readings) => {
        if (!cancelled) setServer(readings.map((reading) => toSnapshot(connection, reading)));
      })
      .catch(() => {
        withoutPlugin.add(connection);
        if (!cancelled) setServer([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, since]);

  // The browser's readings plus the server's, oldest first, per provider.
  const merged = useMemo(() => {
    if (server.length === 0) return history;
    const out: Partial<Record<QuotaProviderType, QuotaSnapshot[]>> = {};
    Object.entries(history).forEach(([provider, snapshots]) => {
      const fromServer = server.filter((snapshot) => snapshot.provider === provider);
      out[provider as QuotaProviderType] = [...(snapshots ?? []), ...fromServer].sort(
        (a, b) => a.ts - b.ts
      );
    });
    return out;
  }, [history, server]);

  const byMeter = useMemo(() => {
    const index = new Map<string, QuotaSnapshot[]>();
    Object.values(merged).forEach((snapshots) =>
      snapshots?.forEach((snapshot) => {
        const key = `${snapshot.credentialId}|${snapshot.window}`;
        const list = index.get(key);
        if (list) list.push(snapshot);
        else index.set(key, [snapshot]);
      })
    );
    return index;
  }, [merged]);

  const historyFor = useCallback((provider: QuotaProviderType) => merged[provider] ?? [], [merged]);
  const snapshotsFor = useCallback(
    (credentialId: string, windowId: string) => byMeter.get(`${credentialId}|${windowId}`) ?? [],
    [byMeter]
  );

  return { historyFor, snapshotsFor, loaded: loadedKey === readKey };
}

export type SnapshotsFor = ReturnType<typeof useQuotaHistory>['snapshotsFor'];
