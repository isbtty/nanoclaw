/**
 * Pure state-machine tests for the per-session early-exit spawn backoff.
 */
import { describe, expect, it } from 'vitest';

import {
  EARLY_EXIT_WINDOW_MS,
  RESET_AFTER_MS,
  SPAWN_BACKOFF_SCHEDULE_S,
  SpawnBackoff,
  spawnDelayMs,
} from './session-spawn-backoff.js';

const T0 = 1_700_000_000_000;
const S = 'sess-1';

/** Spawn at `at`, die `uptimeMs` later with `code`. Returns the exit outcome. */
function crash(b: SpawnBackoff, at: number, code: number | null, uptimeMs = 2_000, stderr: string[] = []) {
  return b.recordExit(S, { code, startedAt: at, now: at + uptimeMs, stderrTail: stderr });
}

describe('spawnDelayMs', () => {
  it('follows the schedule and caps at the last entry', () => {
    expect(spawnDelayMs(0)).toBe(0);
    expect(spawnDelayMs(1)).toBe(0);
    expect(spawnDelayMs(2)).toBe(0);
    expect(spawnDelayMs(3)).toBe(60_000);
    expect(spawnDelayMs(4)).toBe(300_000);
    expect(spawnDelayMs(5)).toBe(900_000);
    expect(spawnDelayMs(50)).toBe(SPAWN_BACKOFF_SCHEDULE_S[SPAWN_BACKOFF_SCHEDULE_S.length - 1] * 1000);
  });
});

describe('SpawnBackoff', () => {
  it('two quick crashes are free; the third starts holding, escalating 1m → 5m → 15m', () => {
    const b = new SpawnBackoff();
    let t = T0;

    expect(crash(b, t, 1)).toMatchObject({ earlyFailure: true, failures: 1, delayMs: 0, escalated: false });
    expect(b.check(S, t + 3_000).blocked).toBe(false);

    t += 60_000;
    expect(crash(b, t, 1)).toMatchObject({ failures: 2, delayMs: 0, escalated: false });
    expect(b.check(S, t + 3_000).blocked).toBe(false);

    t += 60_000;
    const third = crash(b, t, 76, 2_000, ['[agent-runner] Fatal error: database disk image is malformed']);
    expect(third).toMatchObject({ failures: 3, delayMs: 60_000, escalated: true });
    const held = b.check(S, t + 3_000);
    expect(held.blocked).toBe(true);
    expect(held.until).toBe(t + 2_000 + 60_000);
    expect(held.lastExitCode).toBe(76);
    expect(held.lastStderrTail).toEqual(['[agent-runner] Fatal error: database disk image is malformed']);
    expect(b.check(S, t + 2_000 + 60_000).blocked).toBe(false); // hold expired

    t += 120_000;
    expect(crash(b, t, 1)).toMatchObject({ failures: 4, delayMs: 300_000, escalated: true });
    t += 400_000;
    expect(crash(b, t, 1)).toMatchObject({ failures: 5, delayMs: 900_000, escalated: true });
    t += 1_000_000;
    // Capped: same delay, so no further escalation (and no further alert).
    expect(crash(b, t, 1)).toMatchObject({ failures: 6, delayMs: 900_000, escalated: false });
  });

  it('an exit after the early window is not a strike and clears prior strikes', () => {
    const b = new SpawnBackoff();
    crash(b, T0, 1);
    crash(b, T0 + 60_000, 1);
    expect(b.get(S)?.failures).toBe(2);

    const late = b.recordExit(S, { code: 1, startedAt: T0 + 120_000, now: T0 + 120_000 + EARLY_EXIT_WINDOW_MS });
    expect(late.earlyFailure).toBe(false);
    expect(b.get(S)).toBeUndefined();
  });

  it('a clean exit (0) or a host kill (null) clears strikes', () => {
    const b = new SpawnBackoff();
    crash(b, T0, 1);
    crash(b, T0 + 1, 1);
    crash(b, T0 + 2, 1);
    expect(b.check(S, T0 + 3).blocked).toBe(true);

    expect(crash(b, T0 + 10, 0).earlyFailure).toBe(false);
    expect(b.check(S, T0 + 11).blocked).toBe(false);

    crash(b, T0 + 20, 1);
    crash(b, T0 + 21, 1);
    crash(b, T0 + 22, 1);
    expect(crash(b, T0 + 30, null).earlyFailure).toBe(false);
    expect(b.get(S)).toBeUndefined();
  });

  it('an hour of quiet resets the record (check and recordExit both honour it)', () => {
    const b = new SpawnBackoff();
    crash(b, T0, 1);
    crash(b, T0 + 1, 1);
    crash(b, T0 + 2, 1);
    expect(b.get(S)?.failures).toBe(3);

    expect(b.check(S, T0 + 2 + 2_000 + RESET_AFTER_MS).blocked).toBe(false);
    expect(b.get(S)).toBeUndefined();

    crash(b, T0, 1);
    crash(b, T0 + 1, 1);
    // Next strike long after → counts as the first again.
    expect(crash(b, T0 + RESET_AFTER_MS + 10_000, 1).failures).toBe(1);
  });

  it('reset() lets the next spawn through immediately (used after outbound.db recovery)', () => {
    const b = new SpawnBackoff();
    crash(b, T0, 76);
    crash(b, T0 + 1, 76);
    crash(b, T0 + 2, 76);
    expect(b.check(S, T0 + 3).blocked).toBe(true);
    b.reset(S);
    expect(b.check(S, T0 + 3)).toMatchObject({ blocked: false, failures: 0 });
  });

  it('sessions are independent', () => {
    const b = new SpawnBackoff();
    crash(b, T0, 1);
    crash(b, T0 + 1, 1);
    crash(b, T0 + 2, 1);
    expect(b.check('sess-other', T0 + 3).blocked).toBe(false);
  });

  it('keeps only the last five stderr lines', () => {
    const b = new SpawnBackoff();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    crash(b, T0, 1, 1_000, lines);
    expect(b.get(S)?.lastStderrTail).toEqual(lines.slice(5));
  });
});
