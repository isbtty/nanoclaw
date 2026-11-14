/**
 * Data-preserving recovery of a corrupt outbound.db.
 *
 * The first self-heal (#94) replaced a corrupt file with an empty schema.
 * That stops the crash loop but throws away two things the user notices:
 * undelivered replies in `messages_out`, and `session_state` — which holds
 * the provider continuation id, i.e. the agent's whole conversation memory.
 * Both production incidents (2026-11-02, 2026-11-07, isbtty/boswell#846) were
 * freelist-page damage with every table row still readable, and both were
 * repaired by hand with `sqlite3 .recover`. This module does that
 * automatically, in order of preference:
 *
 *   1. `sqlite3 -readonly <copy> .recover | sqlite3 <new>` — the SQLite
 *      shell's recovery extension walks pages directly and rebuilds every
 *      table, including rows that index/freelist damage would hide from a
 *      normal query. Used when a `sqlite3` binary is on PATH.
 *   2. better-sqlite3 row copy — `ensureSchema` on a new file, then for each
 *      table (session_state → processing_ack → messages_out →
 *      container_state) `SELECT * FROM t NOT INDEXED` into it, one row at a
 *      time under try/catch so a torn page costs only the rows on it.
 *   3. Empty schema (the #94 behaviour) when neither produces a file that
 *      passes integrity_check.
 *
 * Whatever method wins, the original file is kept as
 * `outbound.db.corrupt-<stamp>.bak` (its journal alongside), the new file is
 * built under a temporary name and swapped in with an atomic rename. Nothing
 * is ever deleted.
 *
 * Pure filesystem module — no container/session knowledge — so it can be
 * unit-tested against the real corrupt files kept from the incidents.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

import Database from 'better-sqlite3';

import { ensureSchema } from './db/session-db.js';
import { log } from './log.js';

/** Copy order: the most valuable, smallest tables first. */
export const RECOVERY_TABLE_ORDER = ['session_state', 'processing_ack', 'messages_out', 'container_state'] as const;

export type RecoveryMethod = 'sqlite3-recover' | 'row-copy' | 'empty';

export interface TableRecoveryStats {
  /** Rows present in the recovered file. */
  recovered: number;
  /** Rows the source reported (NOT INDEXED count) — null when even that read failed. */
  source: number | null;
  /** Rows lost: source − recovered when both known, else rows that threw during row-copy. */
  dropped: number | null;
}

export interface RecoveryResult {
  method: RecoveryMethod;
  backupPath: string;
  tables: Record<string, TableRecoveryStats>;
  /** `.recover` puts unattributable rows in lost_and_found; counted then dropped from the live file. */
  lostAndFound: number;
  /** Why the higher-preference methods were skipped, for the log line. */
  attempts: string[];
}

export interface RecoveryOptions {
  /** Path to a sqlite3 CLI, or null to force the row-copy path. Default: PATH lookup. */
  sqlite3Bin?: string | null;
  now?: Date;
}

let sqlite3Lookup: string | null | undefined;

/** First `sqlite3` on PATH that answers `-version`, memoized. Null when absent. */
export function findSqlite3Bin(): string | null {
  if (sqlite3Lookup !== undefined) return sqlite3Lookup;
  const res = spawnSync('sqlite3', ['-version'], { encoding: 'utf8', timeout: 5000 });
  sqlite3Lookup = !res.error && res.status === 0 ? 'sqlite3' : null;
  return sqlite3Lookup;
}

export function _resetSqlite3LookupForTesting(): void {
  sqlite3Lookup = undefined;
}

function stamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds(),
  )}`;
}

export function integrityOk(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      return rows.length === 1 && rows[0]?.integrity_check === 'ok';
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function countRows(db: Database.Database, table: string, notIndexed: boolean): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"${notIndexed ? ' NOT INDEXED' : ''}`).get() as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  } catch {
    return null;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  } catch {
    return false;
  }
}

/** Row counts per table in the recovered file, with best-effort source counts. */
function collectStats(recoveredPath: string, sourcePath: string): Record<string, TableRecoveryStats> {
  const out: Record<string, TableRecoveryStats> = {};
  const rec = new Database(recoveredPath, { readonly: true });
  let src: Database.Database | null = null;
  try {
    src = new Database(sourcePath, { readonly: true });
  } catch {
    src = null;
  }
  try {
    for (const table of RECOVERY_TABLE_ORDER) {
      const recovered = countRows(rec, table, false) ?? 0;
      const source = src && tableExists(src, table) ? countRows(src, table, true) : null;
      out[table] = {
        recovered,
        source,
        dropped: source === null ? null : Math.max(0, source - recovered),
      };
    }
  } finally {
    rec.close();
    src?.close();
  }
  return out;
}

/**
 * Method 1: the sqlite3 shell's `.recover`. Emits SQL (including shell
 * dot-commands such as `.dbconfig`), so it must be replayed through the shell
 * too, not through better-sqlite3. Returns null with a reason on any failure.
 */
function recoverViaSqlite3(bin: string, sourcePath: string, targetPath: string): string | null {
  const dump = spawnSync(bin, ['-readonly', '-bail', sourcePath, '.recover'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  if (dump.error) return `sqlite3 .recover spawn failed: ${dump.error.message}`;
  if (dump.status !== 0 || !dump.stdout) {
    return `sqlite3 .recover exited ${dump.status}: ${(dump.stderr || '').trim().slice(0, 300)}`;
  }
  fs.rmSync(targetPath, { force: true });
  const load = spawnSync(bin, ['-bail', targetPath], {
    input: dump.stdout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  if (load.error) return `sqlite3 load spawn failed: ${load.error.message}`;
  if (load.status !== 0) return `sqlite3 load exited ${load.status}: ${(load.stderr || '').trim().slice(0, 300)}`;
  if (!integrityOk(targetPath)) return 'sqlite3 .recover output fails integrity_check';
  return null;
}

/**
 * Method 2: schema'd new file + per-table, per-row copy through better-sqlite3.
 * Returns the number of rows that threw per table (null = total failure).
 */
function recoverViaRowCopy(sourcePath: string, targetPath: string): { dropped: Record<string, number> } | string {
  fs.rmSync(targetPath, { force: true });
  ensureSchema(targetPath, 'outbound');
  let src: Database.Database;
  try {
    src = new Database(sourcePath, { readonly: true });
  } catch (err) {
    return `cannot open source: ${err instanceof Error ? err.message : String(err)}`;
  }
  const dst = new Database(targetPath);
  const dropped: Record<string, number> = {};
  let copiedAny = false;
  try {
    dst.pragma('journal_mode = DELETE');
    for (const table of RECOVERY_TABLE_ORDER) {
      dropped[table] = 0;
      if (!tableExists(src, table)) continue;
      let cols: string[];
      try {
        const srcCols = (src.pragma(`table_info("${table}")`) as Array<{ name: string }>).map((c) => c.name);
        const dstCols = new Set((dst.pragma(`table_info("${table}")`) as Array<{ name: string }>).map((c) => c.name));
        cols = srcCols.filter((c) => dstCols.has(c));
      } catch {
        continue;
      }
      if (cols.length === 0) continue;
      const colList = cols.map((c) => `"${c}"`).join(', ');
      const insert = dst.prepare(
        `INSERT OR IGNORE INTO "${table}" (${colList}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
      );
      // NOT INDEXED: walk the table b-tree itself so a damaged index can't
      // hide rows or abort the scan early.
      let iter: IterableIterator<unknown>;
      try {
        iter = src.prepare(`SELECT ${colList} FROM "${table}" NOT INDEXED`).iterate();
      } catch {
        continue;
      }
      // Pull rows one at a time: a torn page throws mid-iteration, and we
      // keep everything read before it.
      for (;;) {
        let next: IteratorResult<unknown>;
        try {
          next = iter.next();
        } catch {
          dropped[table] += 1;
          break;
        }
        if (next.done) break;
        try {
          insert.run(next.value as Record<string, unknown>);
          copiedAny = true;
        } catch {
          dropped[table] += 1;
        }
      }
    }
  } finally {
    src.close();
    dst.close();
  }
  if (!integrityOk(targetPath)) return 'row-copy output fails integrity_check';
  if (!copiedAny) return 'row-copy read no rows';
  return { dropped };
}

/**
 * Quarantine + recover `dbPath` in place. Precondition: no process has the
 * file open for writing (the container is dead). Steps:
 *
 *   1. rename outbound.db → outbound.db.corrupt-<stamp>.bak (journal too)
 *   2. snapshot the .bak to a journal-free scratch copy and recover from that
 *      (a hot `-journal` next to a read-only open would otherwise refuse)
 *   3. build the new file as outbound.db.recovering-<stamp>, verify
 *      integrity_check, renameSync onto outbound.db (atomic on one fs)
 *
 * Throws only when the rename in step 1 fails (permissions/disk) — then the
 * caller must leave the streak armed and retry later. Any recovery failure
 * degrades to an empty schema so the session can run again.
 */
export function recoverOutboundDb(dbPath: string, opts: RecoveryOptions = {}): RecoveryResult {
  const now = opts.now ?? new Date();
  const bakPath = `${dbPath}.corrupt-${stamp(now)}.bak`;
  const tmpPath = `${dbPath}.recovering-${stamp(now)}`;
  const scratchSrc = `${tmpPath}.src`;
  const attempts: string[] = [];

  fs.renameSync(dbPath, bakPath);
  // A stray rollback journal would be replayed into the *fresh* DB on next
  // open — move it alongside the file it belongs to.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (fs.existsSync(`${dbPath}${suffix}`)) fs.renameSync(`${dbPath}${suffix}`, `${bakPath}${suffix}`);
  }

  let method: RecoveryMethod = 'empty';
  let rowCopyDropped: Record<string, number> | null = null;
  try {
    fs.copyFileSync(bakPath, scratchSrc);

    const bin = opts.sqlite3Bin === undefined ? findSqlite3Bin() : opts.sqlite3Bin;
    if (bin) {
      const failure = recoverViaSqlite3(bin, scratchSrc, tmpPath);
      if (failure === null) method = 'sqlite3-recover';
      else attempts.push(failure);
    } else {
      attempts.push('sqlite3 CLI not available');
    }

    if (method === 'empty') {
      const res = recoverViaRowCopy(scratchSrc, tmpPath);
      if (typeof res === 'string') attempts.push(res);
      else {
        method = 'row-copy';
        rowCopyDropped = res.dropped;
      }
    }
  } catch (err) {
    attempts.push(`recovery threw: ${err instanceof Error ? err.message : String(err)}`);
    method = 'empty';
  }

  if (method === 'empty') {
    fs.rmSync(tmpPath, { force: true });
    ensureSchema(tmpPath, 'outbound');
  } else {
    // Tables added after the file was created (or dropped by .recover) —
    // the container's own lazy init would add them, but the host reads them
    // too, so have the schema complete before anyone opens it.
    ensureSchema(tmpPath, 'outbound');
  }

  let lostAndFound = 0;
  if (method === 'sqlite3-recover') {
    const db = new Database(tmpPath);
    try {
      if (tableExists(db, 'lost_and_found')) {
        lostAndFound = countRows(db, 'lost_and_found', false) ?? 0;
        // Unattributable rows: no table, no schema. Keep the live file clean;
        // the .bak still has every byte for manual salvage.
        db.exec('DROP TABLE lost_and_found');
      }
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
  }

  const tables = collectStats(tmpPath, scratchSrc);
  if (rowCopyDropped) {
    for (const [t, n] of Object.entries(rowCopyDropped)) {
      if (tables[t] && tables[t].dropped === null) tables[t].dropped = n;
    }
  }

  // Clean rollback journals the build left behind, then swap in.
  for (const suffix of ['-journal', '-wal', '-shm']) fs.rmSync(`${tmpPath}${suffix}`, { force: true });
  fs.renameSync(tmpPath, dbPath);
  fs.rmSync(scratchSrc, { force: true });

  const result: RecoveryResult = { method, backupPath: bakPath, tables, lostAndFound, attempts };
  log.warn('Recovered corrupt outbound DB', {
    dbPath,
    method,
    backup: bakPath,
    rows: Object.fromEntries(
      Object.entries(tables).map(([t, s]) => [
        t,
        `${s.recovered}/${s.source ?? '?'}${s.dropped ? ` (-${s.dropped})` : ''}`,
      ]),
    ),
    lostAndFound,
    attempts: attempts.length ? attempts : undefined,
  });
  return result;
}
