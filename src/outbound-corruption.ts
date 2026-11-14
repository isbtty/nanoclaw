/**
 * Host-side self-heal for corrupt outbound.db files.
 *
 * A container hard-killed mid-write (heartbeat ceiling, crash) — or, as the
 * 2026-11-07 incident showed, plain writes through the Docker Desktop
 * virtiofs bind mount — can tear the session's outbound.db ("database disk
 * image is malformed"). Without intervention every spawn dies at boot while
 * the user sees their agent go silent (isbtty/boswell#846).
 *
 * Two entry points feed the same recovery:
 *
 *   noteOutboundCorruption — host-side *read* errors (delivery / sweep).
 *     After QUARANTINE_STREAK consecutive errors on one session, verify on a
 *     fresh connection (quick_check) and recover.
 *
 *   handleContainerCorruptionExit — the container exited with
 *     OUTBOUND_CORRUPTION_EXIT_CODE (76), or died non-zero with a corruption
 *     message in its stderr tail (older image). Freelist-page damage leaves
 *     the host's messages_out reads working while only the container's
 *     writes fail, so the read-streak path never fires — this one does. No
 *     streak: the container already paid for the diagnosis; quick_check
 *     still guards against acting on a stale in-container view.
 *
 * Recovery (src/outbound-recovery.ts) is data-preserving: `sqlite3 .recover`
 * → row copy → empty schema, in that order, and the original is always kept
 * as outbound.db.corrupt-<stamp>.bak. The session's spawn backoff is reset
 * afterwards and the container respawned if inbound work is pending.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { countDueMessages } from './db/session-db.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { recoverOutboundDb } from './outbound-recovery.js';
import { openInboundDb, outboundDbPath } from './session-manager.js';
import { spawnBackoff } from './session-spawn-backoff.js';
import type { Session } from './types.js';

/** Exit code the agent-runner uses for "my outbound.db is corrupt" — see
 *  container/agent-runner/src/db/corruption.ts. Mirrored, not imported: the
 *  two trees share no modules. */
export const OUTBOUND_CORRUPTION_EXIT_CODE = 76;

/** Consecutive corruption errors on one session before quarantine fires.
 *  Active sessions poll at 1s (threshold in ~3s); sweep-only at 60s (~3min). */
const QUARANTINE_STREAK = 3;

const corruptionStreaks = new Map<string, number>();
const quarantineInProgress = new Set<string>();

/**
 * SQLite read-side corruption symptoms. Same matcher as the container-side
 * poll-loop fix: the two corruption result codes plus their message texts
 * (better-sqlite3 sets `code`, but errors can also surface wrapped).
 */
export function isCorruptionError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('database disk image is malformed') || msg.includes('file is not a database');
}

/** A successful outbound read resets the session's corruption streak. */
export function noteOutboundReadOk(sessionId: string): void {
  corruptionStreaks.delete(sessionId);
}

/**
 * Record a corruption error on a session's outbound.db read. Below the
 * streak threshold this only logs; at the threshold it verifies and
 * quarantines. Callers should stop processing the session for this tick.
 */
export function noteOutboundCorruption(session: Session, err: unknown): void {
  if (quarantineInProgress.has(session.id)) return;

  const streak = (corruptionStreaks.get(session.id) ?? 0) + 1;
  corruptionStreaks.set(session.id, streak);
  if (streak < QUARANTINE_STREAK) {
    log.warn('Outbound DB corruption error', { sessionId: session.id, streak, err });
    return;
  }

  // Verify on a fresh connection before doing anything destructive: the
  // poll's handle may have latched a stale view while the file on disk is
  // actually fine. Rename is reversible, but the container kill is not free.
  const dbPath = outboundDbPath(session.agent_group_id, session.id);
  if (quickCheckOk(dbPath)) {
    log.warn('Outbound DB read errors but file passes quick_check — not quarantining', {
      sessionId: session.id,
      streak,
    });
    corruptionStreaks.delete(session.id);
    return;
  }

  quarantineInProgress.add(session.id);
  log.error('Outbound DB corruption confirmed — quarantining', { sessionId: session.id, streak });

  // The container holds the corrupt file's inode open through the bind
  // mount. Kill it first so the fresh file is the only one a new container
  // can open; quarantine runs from the kill's onExit so the old process is
  // guaranteed gone.
  if (isContainerRunning(session.id)) {
    killContainer(session.id, 'outbound.db corrupt — quarantining', () => quarantineOutboundDb(session));
  } else {
    quarantineOutboundDb(session);
  }
}

function quickCheckOk(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.pragma('quick_check') as Array<{ quick_check: string }>;
      return rows.length === 1 && rows[0]?.quick_check === 'ok';
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Container reported a corrupt outbound.db by exit code / stderr. Runs from
 * the container's close handler, so the file has no writer any more.
 */
export function handleContainerCorruptionExit(
  session: Session,
  info: { code: number | null; stderrTail?: string[] },
): void {
  if (quarantineInProgress.has(session.id)) return;
  const dbPath = outboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(dbPath)) return;

  if (quickCheckOk(dbPath)) {
    // The container's view was poisoned but the file is fine (the inbound.db
    // page-cache failure mode, or exit 75 whose stderr also says malformed).
    // A respawn with a fresh mount is the fix; spawn backoff throttles it
    // if it keeps happening.
    log.warn('Container reported outbound corruption but file passes quick_check — not recovering', {
      sessionId: session.id,
      code: info.code,
    });
    return;
  }

  quarantineInProgress.add(session.id);
  log.error('Outbound DB corruption confirmed by container exit — recovering', {
    sessionId: session.id,
    code: info.code,
    stderrTail: info.stderrTail,
  });
  if (isContainerRunning(session.id)) {
    killContainer(session.id, 'outbound.db corrupt — recovering', () => quarantineOutboundDb(session));
  } else {
    quarantineOutboundDb(session);
  }
}

/** True when a container's stderr tail carries a SQLite corruption message
 *  (message text or result-code name — bun:sqlite prints either). */
const CORRUPTION_STDERR_RE = /database disk image is malformed|file is not a database|SQLITE_CORRUPT|SQLITE_NOTADB/;
export function stderrMentionsCorruption(stderrTail: string[] | undefined): boolean {
  return (stderrTail ?? []).some((line) => CORRUPTION_STDERR_RE.test(line));
}

function quarantineOutboundDb(session: Session): void {
  const dbPath = outboundDbPath(session.agent_group_id, session.id);
  try {
    const result = recoverOutboundDb(dbPath);
    log.warn('Recovered corrupt outbound DB — original kept as backup', {
      sessionId: session.id,
      method: result.method,
      backup: result.backupPath,
      sessionStateRows: result.tables.session_state?.recovered ?? 0,
      messagesOutRows: result.tables.messages_out?.recovered ?? 0,
    });

    // The crash loop (if any) was the corrupt file; let the respawn through.
    spawnBackoff.reset(session.id);
    respawnIfWorkPending(session);
  } catch (err) {
    // Rename/recreate failed (permissions, disk). Leave the streak cleared so
    // ongoing corruption rebuilds it and quarantine retries, instead of
    // looping every tick.
    log.error('Outbound DB quarantine failed', { sessionId: session.id, err });
  } finally {
    corruptionStreaks.delete(session.id);
    quarantineInProgress.delete(session.id);
  }
}

/** Respawn the container when inbound work is due, so messages the user sent
 *  while delivery was broken get processed without waiting for the next one. */
function respawnIfWorkPending(session: Session): void {
  try {
    const inDb = openInboundDb(session.agent_group_id, session.id);
    let due = 0;
    try {
      due = countDueMessages(inDb);
    } finally {
      inDb.close();
    }
    if (due === 0) return;
    const fresh = getSession(session.id);
    if (fresh) void wakeContainer(fresh);
  } catch (err) {
    log.warn('Post-quarantine respawn check failed — container will wake on next message or sweep', {
      sessionId: session.id,
      err,
    });
  }
}
