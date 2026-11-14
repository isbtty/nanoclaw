/**
 * SQLite corruption detection + the exit codes the agent-runner uses to tell
 * the host *which* session DB is broken.
 *
 * The host only sees the container's exit code and a stderr tail, so the code
 * carries the diagnosis:
 *
 *   75  inbound.db read view is poisoned (cross-mount page-cache coherency on
 *       Docker Desktop / virtiofs). The file on the host is fine; a fresh
 *       container mount fixes it. Host just respawns. See poll-loop.ts.
 *
 *   76  outbound.db — the file this container owns and writes — is physically
 *       corrupt (quick_check fails on a fresh connection). Nothing inside the
 *       container can repair it; the host must recover/quarantine the file
 *       before respawning (src/outbound-corruption.ts), otherwise every
 *       respawn dies at `getOutboundDb()` and the session loops forever.
 *       This is the exact failure mode of the 2026-11-02 / 2026-11-07
 *       takbot-group incidents (isbtty/boswell#846).
 *
 * Both are documented in docs/outbound-db-corruption.md.
 */
import { Database } from 'bun:sqlite';

export const INBOUND_CORRUPTION_EXIT_CODE = 75;
export const OUTBOUND_CORRUPTION_EXIT_CODE = 76;

/**
 * True for SQLite errors that indicate a corrupt read/write view: the two
 * corruption result codes plus their message texts. Accepts the raw error
 * or an already-stringified message.
 */
export function isCorruptionError(err: unknown): boolean {
  if (err == null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('SQLITE_NOTADB') ||
    msg.includes('file is not a database')
  );
}

/**
 * Thrown by getOutboundDb() when opening/initializing outbound.db hits a
 * corruption error. Tagged so index.ts can exit 76 without re-checking.
 */
export class OutboundCorruptionError extends Error {
  readonly cause: unknown;
  constructor(stage: string, cause: unknown) {
    const inner = cause instanceof Error ? cause.message : String(cause);
    super(`outbound.db corrupt (${stage}): ${inner}`);
    this.name = 'OutboundCorruptionError';
    this.cause = cause;
  }
}

/**
 * Verify on a *fresh* read-only connection whether outbound.db is physically
 * corrupt. A corruption error alone doesn't say which file it came from
 * (getPendingMessages joins both DBs), so callers use this to decide between
 * exit 75 (inbound view) and exit 76 (outbound file). The container is the
 * sole writer of outbound.db, so a failing quick_check here is never a
 * transient mid-write artefact. Returns false when the file doesn't exist
 * (nothing to be corrupt yet).
 */
export function outboundFileIsCorrupt(path: string): boolean {
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    return !(rows.length === 1 && rows[0]?.quick_check === 'ok');
  } catch (err) {
    // ENOENT / unable to open → not corruption. SQLITE_NOTADB / CORRUPT → is.
    return isCorruptionError(err);
  } finally {
    db?.close();
  }
}

/**
 * Exit code for a fatal error, or null when it isn't a DB-corruption exit.
 * `outboundPath` is only consulted for untagged corruption errors.
 */
export function corruptionExitCode(err: unknown, outboundPath: string): number | null {
  if (err instanceof OutboundCorruptionError) return OUTBOUND_CORRUPTION_EXIT_CODE;
  if (!isCorruptionError(err)) return null;
  return outboundFileIsCorrupt(outboundPath) ? OUTBOUND_CORRUPTION_EXIT_CODE : INBOUND_CORRUPTION_EXIT_CODE;
}
