/**
 * Server-side quota readings from the `quota-history` plugin, when the backend
 * has it. The plugin declares its route under `/v0/management`, so the URL is
 * absolute rather than relative to the v8 prefix.
 */

import { apiClient } from './client';
import { normalizeApiBase } from '@/utils/connection';
import { isRecord } from '@/utils/helpers';

export interface ServerQuotaReading {
  ts: number;
  /** Credential file name, the panel's quota key for Claude and Codex. */
  credential: string;
  provider: string;
  window: string;
  remaining: number;
  resetAtMs: number | null;
}

const READINGS_TIMEOUT_MS = 15 * 1000;

const finiteOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const normalizeReading = (value: unknown): ServerQuotaReading | null => {
  if (!isRecord(value)) return null;
  const ts = finiteOrNull(value.ts);
  const remaining = finiteOrNull(value.remaining);
  const { credential, provider, window } = value;
  if (ts === null || remaining === null) return null;
  if (typeof credential !== 'string' || typeof provider !== 'string') return null;
  if (typeof window !== 'string') return null;
  return {
    ts,
    credential,
    provider,
    window,
    remaining,
    resetAtMs: finiteOrNull(value.reset_at_ms),
  };
};

export const quotaHistoryApi = {
  /** Readings at or after `sinceMs`; rejects when the plugin is not installed. */
  readings: async (apiBase: string, sinceMs: number): Promise<ServerQuotaReading[]> => {
    const url = `${normalizeApiBase(apiBase)}/v0/management/quota-history/readings`;
    const data = await apiClient.get<unknown>(url, {
      params: { since: Math.floor(sinceMs) },
      timeout: READINGS_TIMEOUT_MS,
    });
    const readings = isRecord(data) && Array.isArray(data.readings) ? data.readings : [];
    return readings
      .map(normalizeReading)
      .filter((reading): reading is ServerQuotaReading => reading !== null);
  },
};
