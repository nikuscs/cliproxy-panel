/**
 * Dev-only quota scenario shared by the mock Management API (Vite middleware)
 * and the browser history seeder. Self-contained on purpose: vite.config.ts
 * bundles it without the `@/` alias, and production builds never import it.
 *
 * Every credential drains linearly inside its weekly window and refills at the
 * window boundary, so the server's "now" and the seeded history agree.
 */

const HOUR = 3_600_000;
const WEEK_HOURS = 168;

export type MockProvider = 'claude' | 'codex' | 'xai' | 'kimi';

export interface MockCredential {
  name: string;
  email: string;
  provider: MockProvider;
  authIndex: string;
  /** Next weekly reset, in hours after the UTC day start. */
  resetOffsetHours: number;
  /** Weekly drain, percent per hour. */
  drainPerHour: number;
  /** Upstream quota read fails (credential renders as "needs attention"). */
  failing?: boolean;
  /**
   * Minutes since the proxy last used it, i.e. the age of the passive quota
   * snapshot CPA attaches to the auth-files list. Omitted = no snapshot (as
   * after a server restart), so the panel's own cache is the only fallback.
   */
  passiveAgeMinutes?: number;
}

export const MOCK_CREDENTIALS: MockCredential[] = [
  {
    name: 'main',
    email: 'ada@t3.chat',
    provider: 'claude',
    authIndex: 'mock-1',
    resetOffsetHours: 68,
    drainPerHour: 1.5,
    passiveAgeMinutes: 90,
  },
  {
    name: 'gmail',
    email: 'ada.dev@example.com',
    provider: 'claude',
    authIndex: 'mock-2',
    resetOffsetHours: 88,
    drainPerHour: 0.065,
    passiveAgeMinutes: 2,
  },
  {
    name: 'work',
    email: 'ada@example.org',
    provider: 'claude',
    authIndex: 'mock-3',
    resetOffsetHours: 37,
    drainPerHour: 0.55,
    passiveAgeMinutes: 1,
  },
  {
    name: 'personal',
    email: 'ada.personal@example.net',
    provider: 'claude',
    authIndex: 'mock-4',
    resetOffsetHours: 121,
    drainPerHour: 0.75,
  },
  {
    name: 'team-shared-enterprise-workspace-seat-04',
    email: 'shared.workspace.owner@enterprise.example.com',
    provider: 'claude',
    authIndex: 'mock-5',
    resetOffsetHours: 157,
    drainPerHour: 1.25,
    passiveAgeMinutes: 6,
  },
  {
    // Real credential files are named after the account, extension included.
    name: 'backup@t3.chat.json',
    email: 'backup@t3.chat',
    provider: 'claude',
    authIndex: 'mock-6',
    resetOffsetHours: 37,
    drainPerHour: 0.32,
    passiveAgeMinutes: 3,
  },
  {
    name: 'codex main',
    email: 'ada@openai-mock.dev',
    provider: 'codex',
    authIndex: 'mock-7',
    resetOffsetHours: 50,
    drainPerHour: 0.4,
    passiveAgeMinutes: 4,
  },
  {
    name: 'codex alt',
    email: 'alt@openai-mock.dev',
    provider: 'codex',
    authIndex: 'mock-8',
    resetOffsetHours: 98,
    drainPerHour: 0.9,
    passiveAgeMinutes: 25,
  },
  {
    name: 'codex ci',
    email: 'ci@openai-mock.dev',
    provider: 'codex',
    authIndex: 'mock-9',
    resetOffsetHours: 140,
    drainPerHour: 0.2,
  },
  {
    name: 'grok',
    email: 'ada@x-mock.dev',
    provider: 'xai',
    authIndex: 'mock-10',
    resetOffsetHours: 80,
    drainPerHour: 0.3,
    failing: true,
  },
  {
    name: 'kimi',
    email: 'ada@kimi-mock.dev',
    provider: 'kimi',
    authIndex: 'mock-11',
    resetOffsetHours: 60,
    drainPerHour: 0.3,
    failing: true,
  },
];

const utcDayStart = (ms: number) => Math.floor(ms / (24 * HOUR)) * 24 * HOUR;

/** End of the weekly window containing `atMs`. */
export function mockWindowEnd(credential: MockCredential, atMs: number, nowMs: number): number {
  const anchor = utcDayStart(nowMs) + credential.resetOffsetHours * HOUR;
  const period = WEEK_HOURS * HOUR;
  const end = anchor + Math.ceil((atMs - anchor) / period) * period;
  return end === atMs ? end + period : end;
}

/** Weekly remaining percent at `atMs`. */
export function mockWeeklyRemaining(
  credential: MockCredential,
  atMs: number,
  nowMs: number
): number {
  const start = mockWindowEnd(credential, atMs, nowMs) - WEEK_HOURS * HOUR;
  const elapsedHours = (atMs - start) / HOUR;
  return Math.round(Math.max(0, Math.min(100, 100 - credential.drainPerHour * elapsedHours)));
}

/** 5-hour window: resets on 5-hour boundaries of the UTC day, drains 8x faster. */
export function mockFiveHour(credential: MockCredential, nowMs: number) {
  const period = 5 * HOUR;
  const start = Math.floor(nowMs / period) * period;
  const elapsedHours = (nowMs - start) / HOUR;
  return {
    remaining: Math.round(Math.max(0, 100 - credential.drainPerHour * 8 * elapsedHours)),
    resetAtMs: start + period,
  };
}
