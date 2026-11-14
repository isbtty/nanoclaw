/**
 * Per-session spawn backoff — stop the "wake → die at boot → wake" loop.
 *
 * host-sweep wakes any session with due inbound work once a minute. When the
 * container dies seconds after spawn (corrupt outbound.db, bad provider
 * config, missing binary…) that becomes an unattended infinite loop: the
 * 2026-11-02 incident spawned ~300 containers over five hours before a human
 * noticed one log line repeating. src/circuit-breaker.ts protects the *host*
 * process from its own crash loop; this is the same idea per session, in
 * memory (a host restart resets it, which is fine — the operator just
 * intervened).
 *
 * Pure state machine: callers pass `now`, nothing here reads clocks, logs or
 * spawns. The singleton at the bottom is what container-runner / host-sweep
 * use; tests build their own instance.
 *
 *   consecutive early failures   1   2   3    4    5+
 *   delay before next spawn      0   0   1m   5m   15m   (cap)
 *
 * An "early failure" is a non-zero exit within EARLY_EXIT_WINDOW_MS of spawn.
 * A clean exit, an exit after the window, a host-initiated kill (code null)
 * or RESET_AFTER_MS of quiet all clear the record. Explicit `reset()` is for
 * callers that fixed the cause (outbound.db recovered) and want an immediate
 * respawn.
 */

export const EARLY_EXIT_WINDOW_MS = 30_000;
export const RESET_AFTER_MS = 60 * 60 * 1000;
/** Index = consecutive early failures − 1; the last entry repeats. */
export const SPAWN_BACKOFF_SCHEDULE_S = [0, 0, 60, 300, 900];

export interface EarlyFailureRecord {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
  lastExitCode: number | null;
  lastStderrTail: string[];
}

export interface ExitOutcome {
  /** True when this exit counted as an early failure. */
  earlyFailure: boolean;
  failures: number;
  /** Delay applied to the next spawn, in ms (0 = none). */
  delayMs: number;
  /** True exactly when the delay stepped up — the moment worth alerting a human. */
  escalated: boolean;
}

export interface BlockState {
  blocked: boolean;
  /** Epoch ms when spawning is allowed again (0 when not blocked). */
  until: number;
  failures: number;
  lastExitCode: number | null;
  lastStderrTail: string[];
}

export function spawnDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  const idx = Math.min(failures - 1, SPAWN_BACKOFF_SCHEDULE_S.length - 1);
  return SPAWN_BACKOFF_SCHEDULE_S[idx] * 1000;
}

export class SpawnBackoff {
  private readonly records = new Map<string, EarlyFailureRecord>();

  /**
   * Record a container exit. `startedAt` is the spawn time; `code` null means
   * killed by signal (host kill — not the container's fault).
   */
  recordExit(
    sessionId: string,
    args: { code: number | null; startedAt: number; now: number; stderrTail?: string[] },
  ): ExitOutcome {
    const { code, startedAt, now } = args;
    const uptime = now - startedAt;
    const early = code !== 0 && code !== null && uptime < EARLY_EXIT_WINDOW_MS;
    if (!early) {
      // Ran long enough, exited cleanly, or was killed on purpose — any of
      // those says the session itself is viable; forget prior strikes.
      if (code === 0 || code === null || uptime >= EARLY_EXIT_WINDOW_MS) this.records.delete(sessionId);
      return { earlyFailure: false, failures: 0, delayMs: 0, escalated: false };
    }

    const prev = this.records.get(sessionId);
    const stale = prev && now - prev.lastFailureAt >= RESET_AFTER_MS;
    const failures = prev && !stale ? prev.failures + 1 : 1;
    const delayMs = spawnDelayMs(failures);
    const prevDelay = prev && !stale ? spawnDelayMs(prev.failures) : 0;
    this.records.set(sessionId, {
      failures,
      lastFailureAt: now,
      blockedUntil: delayMs > 0 ? now + delayMs : 0,
      lastExitCode: code,
      lastStderrTail: (args.stderrTail ?? []).slice(-5),
    });
    return { earlyFailure: true, failures, delayMs, escalated: delayMs > prevDelay };
  }

  /** Whether a spawn for this session should be held right now. */
  check(sessionId: string, now: number): BlockState {
    const rec = this.records.get(sessionId);
    if (!rec) return { blocked: false, until: 0, failures: 0, lastExitCode: null, lastStderrTail: [] };
    if (now - rec.lastFailureAt >= RESET_AFTER_MS) {
      this.records.delete(sessionId);
      return { blocked: false, until: 0, failures: 0, lastExitCode: null, lastStderrTail: [] };
    }
    return {
      blocked: rec.blockedUntil > now,
      until: rec.blockedUntil > now ? rec.blockedUntil : 0,
      failures: rec.failures,
      lastExitCode: rec.lastExitCode,
      lastStderrTail: rec.lastStderrTail,
    };
  }

  /** Forget a session's strikes — the cause was fixed (e.g. outbound.db recovered). */
  reset(sessionId: string): void {
    this.records.delete(sessionId);
  }

  /** Test/diagnostic helper. */
  get(sessionId: string): EarlyFailureRecord | undefined {
    return this.records.get(sessionId);
  }
}

/** Process-wide instance shared by container-runner and host-sweep. */
export const spawnBackoff = new SpawnBackoff();
