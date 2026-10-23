/**
 * Dev-only: seed three days of quota history for the mock scenario, with a
 * six-hour gap so the chart shows that gaps stay gaps. Loaded through a
 * dynamic import behind `import.meta.env.DEV`, so production drops it.
 */

import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { recordQuotaSnapshots, type QuotaSnapshot } from '../forecast/quotaHistory';
import { MOCK_CREDENTIALS, mockWeeklyRemaining, mockWindowEnd } from './mockScenario';

const SEEDED_KEY = 'quotaMock.seeded';
const STEP_MS = 20 * MINUTE_MS;
const GAP = { fromHoursAgo: 14, toHoursAgo: 8 };

const PRIMARY_WINDOW: Record<string, string> = { claude: 'seven-day', codex: 'weekly' };

export async function seedMockHistory(connection: string): Promise<void> {
  const seededKey = `${SEEDED_KEY}:${connection}`;
  if (localStorage.getItem(seededKey)) return;
  localStorage.setItem(seededKey, '1');

  const nowMs = Date.now();
  const snapshots: QuotaSnapshot[] = [];
  for (let ts = nowMs - 72 * HOUR_MS; ts < nowMs - STEP_MS; ts += STEP_MS) {
    const hoursAgo = (nowMs - ts) / HOUR_MS;
    if (hoursAgo < GAP.fromHoursAgo && hoursAgo > GAP.toHoursAgo) continue;
    MOCK_CREDENTIALS.forEach((credential) => {
      const window = PRIMARY_WINDOW[credential.provider];
      if (!window || credential.failing) return;
      snapshots.push({
        connection,
        ts,
        credentialId: credential.name,
        provider: credential.provider as QuotaSnapshot['provider'],
        window,
        remaining: mockWeeklyRemaining(credential, ts, nowMs),
        resetAtMs: mockWindowEnd(credential, ts, nowMs),
        primary: true,
      });
    });
  }
  await recordQuotaSnapshots(snapshots);
}
