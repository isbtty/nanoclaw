/**
 * Host-side self-heal for corrupt outbound.db files.
 *
 * A container hard-killed mid-write (heartbeat ceiling, crash) can tear the
 * session's outbound.db — journal_mode=DELETE plus the Docker Desktop macOS
 * virtiofs coherency quirk (see container/agent-runner PR #2597) leaves the
 * file unreadable ("database disk image is malformed"). The host cannot
 * repair the file, and without intervention every delivery poll fails
 * forever while the user sees their agent go silent.
 *
 * Mirror of the container-side inbound.db streak-exit fix, but on the host:
 * after QUARANTINE_STREAK consecutive corruption errors on the same session,
 * verify the corruption on a fresh connection (quick_check), kill the
 * session's container (it holds the old inode via the bind mount), rename
 * the corrupt file to outbound.db.corrupt-<stamp>.bak, recreate a fresh DB
 * from schema, and respawn the container if inbound work is pending.
 *
 * Undelivered rows in the corrupt file stay in the .bak for manual salvage —
 * quarantine never deletes data.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { countDueMessages, ensureSchema } from './db/session-db.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { openInboundDb, outboundDbPath } from './session-manager.js';
import type { Session } from './types.js';

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

function quarantineOutboundDb(session: Session): void {
  const dbPath = outboundDbPath(session.agent_group_id, session.id);
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
      d.getMinutes(),
    )}${pad(d.getSeconds())}`;
    const bakPath = `${dbPath}.corrupt-${stamp}.bak`;

    fs.renameSync(dbPath, bakPath);
    // A stray rollback journal would be replayed into the *fresh* DB on next
    // open — move it alongside the file it belongs to.
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (fs.existsSync(`${dbPath}${suffix}`)) fs.renameSync(`${dbPath}${suffix}`, `${bakPath}${suffix}`);
    }
    ensureSchema(dbPath, 'outbound');
    log.warn('Quarantined corrupt outbound DB — fresh DB created; undelivered rows remain in the backup', {
      sessionId: session.id,
      backup: bakPath,
    });

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
