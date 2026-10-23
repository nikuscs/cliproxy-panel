/**
 * Dev-only mock of the v8 Management API endpoints the Quota page uses.
 *
 * Enabled by `bun run dev:mock` (VITE_QUOTA_MOCK=1). Log in with the dev
 * server's own URL and any management key. `apply: 'serve'` keeps it out of
 * `vite build`, and nothing in the app bundle imports this file.
 */

import {
  MOCK_CREDENTIALS,
  mockFiveHour,
  mockWeeklyRemaining,
  mockWindowEnd,
  type MockCredential,
} from './mockScenario';

const PREFIX = '/v8/management';
/** `VITE_QUOTA_MOCK_EMPTY=1 bun run dev:mock` serves no credentials (empty states). */
const MOCK_EMPTY =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .VITE_QUOTA_MOCK_EMPTY === '1';
const MOCK_LATENCY_MS = 1500;

/* Minimal structural types so this file needs no Node type definitions. */
interface MockRequest {
  url?: string;
  method?: string;
  on(event: 'data' | 'end', listener: (chunk?: unknown) => void): void;
}

interface MockResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

interface MockServer {
  middlewares: {
    use(handler: (req: MockRequest, res: MockResponse, next: () => void) => void): void;
  };
}

const PROVIDER_TYPES: Record<MockCredential['provider'], string> = {
  claude: 'claude',
  codex: 'codex',
  xai: 'xai',
  kimi: 'kimi',
};

const sendJson = (res: MockResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const readBody = (req: MockRequest): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });

/** Passive snapshot in CPA's shape: canonical header names, observed_at RFC 3339. */
const passiveQuota = (credential: MockCredential, nowMs: number) => {
  if (credential.passiveAgeMinutes === undefined) return { signals: {} };
  const observedAtMs = nowMs - credential.passiveAgeMinutes * 60_000;
  const weekly = mockWeeklyRemaining(credential, observedAtMs, nowMs);
  const weeklyResetSec = String(Math.round(mockWindowEnd(credential, observedAtMs, nowMs) / 1000));
  const fiveHour = mockFiveHour(credential, observedAtMs);
  const fiveHourResetSec = String(Math.round(fiveHour.resetAtMs / 1000));
  const signals: Record<string, string> =
    credential.provider === 'claude'
      ? {
          'Anthropic-Ratelimit-Unified-5h-Utilization': ((100 - fiveHour.remaining) / 100).toFixed(
            2
          ),
          'Anthropic-Ratelimit-Unified-5h-Reset': fiveHourResetSec,
          'Anthropic-Ratelimit-Unified-7d-Utilization': ((100 - weekly) / 100).toFixed(2),
          'Anthropic-Ratelimit-Unified-7d-Reset': weeklyResetSec,
          'Anthropic-Ratelimit-Unified-Status': weekly > 0 ? 'allowed' : 'rejected',
        }
      : {
          'X-Codex-Plan-Type': 'pro',
          'X-Codex-Primary-Used-Percent': String(100 - fiveHour.remaining),
          'X-Codex-Primary-Window-Minutes': '300',
          'X-Codex-Primary-Reset-At': fiveHourResetSec,
          'X-Codex-Secondary-Used-Percent': String(100 - weekly),
          'X-Codex-Secondary-Window-Minutes': '10080',
          'X-Codex-Secondary-Reset-At': weeklyResetSec,
        };
  return { observed_at: new Date(observedAtMs).toISOString(), signals };
};

const credentialFile = (credential: MockCredential) => ({
  name: credential.name,
  type: PROVIDER_TYPES[credential.provider],
  provider: PROVIDER_TYPES[credential.provider],
  email: credential.email,
  auth_index: credential.authIndex,
  status: 'active',
  disabled: false,
  ...(credential.provider === 'claude' || credential.provider === 'codex'
    ? { quota: passiveQuota(credential, Date.now()) }
    : {}),
});

const claudeUsage = (credential: MockCredential, nowMs: number) => {
  const weekly = mockWeeklyRemaining(credential, nowMs, nowMs);
  const weeklyResetIso = new Date(mockWindowEnd(credential, nowMs, nowMs)).toISOString();
  const fiveHour = mockFiveHour(credential, nowMs);
  const exhausted = weekly <= 0;
  return {
    five_hour: {
      utilization: exhausted ? 0 : 100 - fiveHour.remaining,
      resets_at: exhausted ? null : new Date(fiveHour.resetAtMs).toISOString(),
    },
    seven_day: { utilization: 100 - weekly, resets_at: weeklyResetIso },
    limits: [
      {
        kind: 'weekly_scoped',
        percent: 0,
        resets_at: weeklyResetIso,
        is_active: true,
        scope: { model: { display_name: 'Fable 5' } },
      },
    ],
  };
};

const codexUsage = (credential: MockCredential, nowMs: number) => {
  const weekly = mockWeeklyRemaining(credential, nowMs, nowMs);
  const fiveHour = mockFiveHour(credential, nowMs);
  return {
    plan_type: 'pro',
    rate_limit: {
      allowed: weekly > 0,
      limit_reached: weekly <= 0,
      primary_window: {
        used_percent: 100 - fiveHour.remaining,
        limit_window_seconds: 5 * 3600,
        reset_at: Math.round(fiveHour.resetAtMs / 1000),
      },
      secondary_window: {
        used_percent: 100 - weekly,
        limit_window_seconds: 7 * 24 * 3600,
        reset_at: Math.round(mockWindowEnd(credential, nowMs, nowMs) / 1000),
      },
    },
  };
};

const upstreamResponse = (body: Record<string, unknown>) => {
  const credential = MOCK_CREDENTIALS.find((item) => item.authIndex === body.authIndex);
  const url = String(body.url ?? '');
  const nowMs = Date.now();
  const ok = (payload: unknown) => ({
    status_code: 200,
    header: {},
    body: JSON.stringify(payload),
  });
  const fail = (status: number, message: string) => ({
    status_code: status,
    header: {},
    body: JSON.stringify({ error: { message } }),
  });

  if (!credential) return fail(404, 'unknown credential');
  if (credential.failing) return fail(503, 'mock upstream unavailable');
  if (url.includes('/api/oauth/usage?cedar_ember')) {
    return ok({ cedar_ember: { eligible: false, at_limit: false, grants: [] } });
  }
  if (url.endsWith('/api/oauth/usage')) return ok(claudeUsage(credential, nowMs));
  if (url.endsWith('/wham/usage')) return ok(codexUsage(credential, nowMs));
  if (url.endsWith('/wham/rate-limit-reset-credits')) {
    return ok({ credits: [], available_count: 0 });
  }
  return fail(404, 'not mocked');
};

export function quotaMockApi() {
  return {
    name: 'quota-mock-management-api',
    apply: 'serve' as const,
    configureServer(server: MockServer) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith(PREFIX)) return next();
        const route = path.slice(PREFIX.length);

        if (req.method === 'GET' && route === '/config') return sendJson(res, 200, {});
        if (req.method === 'GET' && route === '/credentials') {
          const files = MOCK_EMPTY ? [] : MOCK_CREDENTIALS.map(credentialFile);
          console.info(`[quota-mock] credentials (${files.length})`);
          return sendJson(res, 200, { files });
        }
        if (req.method === 'POST' && route === '/requests/api-call') {
          // Real upstream reads take a moment; the delay makes background
          // refreshes visible. Each read is logged to the dev-server console.
          void readBody(req).then((body) => {
            console.info(`[quota-mock] api-call ${String(body.authIndex)} ${String(body.url)}`);
            setTimeout(() => sendJson(res, 200, upstreamResponse(body)), MOCK_LATENCY_MS);
          });
          return;
        }
        return sendJson(res, 404, { error: 'not mocked' });
      });
    },
  };
}
