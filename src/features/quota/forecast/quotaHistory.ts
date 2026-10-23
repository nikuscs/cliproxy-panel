/**
 * Panel-owned quota storage in IndexedDB.
 *
 * CLIProxyAPI keeps no quota history, so the panel records:
 * - `snapshots`: one row per meter on every quota observation (live fetch or
 *   the server's passive snapshot), pruned after `HISTORY_RETENTION_MS`;
 * - `latest`: the last successful quota state per credential, so the page can
 *   show last known values immediately after a reload.
 * Both are scoped to the connected server. Every call degrades to a no-op when
 * IndexedDB is unavailable (private mode, SSR tests).
 */

import { DAY_MS } from '@/utils/time/durations';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';

export interface QuotaSnapshot {
  /** Connected server base URL; keeps two backends' histories apart. */
  connection: string;
  ts: number;
  credentialId: string;
  provider: QuotaProviderType;
  window: string;
  remaining: number;
  resetAtMs: number | null;
  primary: boolean;
}

export interface LatestQuota {
  connection: string;
  credentialId: string;
  provider: QuotaProviderType;
  /** When the stored state was observed upstream. */
  ts: number;
  state: QuotaCardState;
}

export const HISTORY_RETENTION_MS = 30 * DAY_MS;

const DB_NAME = 'cliproxy-quota-history';
const DB_VERSION = 2;
const SNAPSHOTS = 'snapshots';
const LATEST = 'latest';

let dbPromise: Promise<IDBDatabase | null> | null = null;
let prunedThisSession = false;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        const store = db.createObjectStore(SNAPSHOTS, { autoIncrement: true });
        store.createIndex('ts', 'ts');
        store.createIndex('connection_provider_ts', ['connection', 'provider', 'ts']);
      }
      if (!db.objectStoreNames.contains(LATEST)) {
        const store = db.createObjectStore(LATEST, { keyPath: ['connection', 'credentialId'] });
        store.createIndex('connection', 'connection');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer tab upgrade the schema instead of blocking it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      // Try again on the next call rather than staying without history.
      dbPromise = null;
      resolve(null);
    };
  });
  return dbPromise;
}

const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });

export async function recordQuotaSnapshots(snapshots: QuotaSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return;
  const db = await openDb();
  if (!db) return;
  const transaction = db.transaction(SNAPSHOTS, 'readwrite');
  const store = transaction.objectStore(SNAPSHOTS);
  snapshots.forEach((snapshot) => store.add(snapshot));
  await done(transaction);
  if (!prunedThisSession) {
    prunedThisSession = true;
    await pruneQuotaHistory(Date.now() - HISTORY_RETENTION_MS);
  }
}

export async function pruneQuotaHistory(beforeMs: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const transaction = db.transaction(SNAPSHOTS, 'readwrite');
  const request = transaction
    .objectStore(SNAPSHOTS)
    .index('ts')
    .openCursor(IDBKeyRange.upperBound(beforeMs));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await done(transaction);
}

/** Snapshots for one provider since `sinceMs`, oldest first. */
export async function readQuotaHistory(
  connection: string,
  provider: QuotaProviderType,
  sinceMs: number
): Promise<QuotaSnapshot[]> {
  const db = await openDb();
  if (!db) return [];
  const transaction = db.transaction(SNAPSHOTS, 'readonly');
  const range = IDBKeyRange.bound(
    [connection, provider, sinceMs],
    [connection, provider, Infinity]
  );
  const request = transaction.objectStore(SNAPSHOTS).index('connection_provider_ts').getAll(range);
  await done(transaction);
  return (request.result as QuotaSnapshot[] | undefined) ?? [];
}

export async function saveLatestQuota(records: LatestQuota[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDb();
  if (!db) return;
  const transaction = db.transaction(LATEST, 'readwrite');
  const store = transaction.objectStore(LATEST);
  records.forEach((record) => store.put(record));
  await done(transaction);
}

/** Last successful state per credential for one server, keyed by credential id. */
export async function readLatestQuota(connection: string): Promise<Record<string, LatestQuota>> {
  const db = await openDb();
  if (!db) return {};
  const transaction = db.transaction(LATEST, 'readonly');
  const request = transaction.objectStore(LATEST).index('connection').getAll(connection);
  await done(transaction);
  const latest: Record<string, LatestQuota> = {};
  ((request.result as LatestQuota[] | undefined) ?? []).forEach((record) => {
    latest[record.credentialId] = record;
  });
  return latest;
}
