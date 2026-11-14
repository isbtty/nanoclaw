/**
 * Tests for the host-side outbound.db corruption self-heal.
 *
 * Drives noteOutboundCorruption against real files on disk: a genuinely
 * corrupt outbound.db must be renamed to a .corrupt-*.bak and replaced with
 * a fresh schema'd DB after the streak threshold, while a healthy file that
 * merely produced read errors (stale handle view) must be left alone.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-outbound-corruption' };
});

const isContainerRunning = vi.fn(() => false);
const killContainer = vi.fn();
const wakeContainer = vi.fn(async () => true);
vi.mock('./container-runner.js', () => ({
  isContainerRunning: (...args: unknown[]) => isContainerRunning(...(args as [])),
  killContainer: (...args: unknown[]) => killContainer(...(args as [])),
  wakeContainer: (...args: unknown[]) => wakeContainer(...(args as [])),
}));

const getSession = vi.fn();
vi.mock('./db/sessions.js', async () => {
  const actual = await vi.importActual<typeof import('./db/sessions.js')>('./db/sessions.js');
  return { ...actual, getSession: (...args: unknown[]) => getSession(...(args as [string])) };
});

import {
  handleContainerCorruptionExit,
  isCorruptionError,
  noteOutboundCorruption,
  noteOutboundReadOk,
  OUTBOUND_CORRUPTION_EXIT_CODE,
  stderrMentionsCorruption,
} from './outbound-corruption.js';
import { insertMessage } from './db/session-db.js';
import { spawnBackoff } from './session-spawn-backoff.js';
import { initSessionFolder, inboundDbPath, outboundDbPath, sessionDir } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-outbound-corruption';
const AG = 'ag-test';

let sessCounter = 0;
function makeSession(): Session {
  const id = `sess-corrupt-${++sessCounter}`;
  initSessionFolder(AG, id);
  return {
    id,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
  } as unknown as Session;
}

function corruptOutboundDb(session: Session): void {
  fs.writeFileSync(outboundDbPath(AG, session.id), 'this is definitely not a sqlite database\0garbage');
}

function corruptionErr(): Error & { code: string } {
  return Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
}

function bakFiles(session: Session): string[] {
  return fs.readdirSync(sessionDir(AG, session.id)).filter((f) => f.includes('.corrupt-') && f.endsWith('.bak'));
}

/** Valid header + schema page, data pages trashed: opens, CREATE TABLE IF NOT
 *  EXISTS succeeds, data access fails. The shape of the real incidents. */
function trashDataPages(session: Session): void {
  const p = outboundDbPath(AG, session.id);
  const db = new Database(p);
  db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
    'continuation:claude',
    'c1',
    'now',
  );
  for (let i = 0; i < 20; i++) {
    db.prepare(`INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, 'now', 'chat', ?)`).run(
      `m${i}`,
      i * 2 + 1,
      'y'.repeat(3000),
    );
  }
  db.close();
  const buf = fs.readFileSync(p);
  for (let i = Math.floor(buf.length * 0.5); i < buf.length; i++) buf[i] = 0xa5;
  fs.writeFileSync(p, buf);
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  vi.clearAllMocks();
  isContainerRunning.mockReturnValue(false);
  killContainer.mockReset();
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('isCorruptionError', () => {
  it('matches the SQLite corruption codes', () => {
    expect(isCorruptionError(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(true);
    expect(isCorruptionError(Object.assign(new Error('x'), { code: 'SQLITE_NOTADB' }))).toBe(true);
  });

  it('matches the corruption message texts', () => {
    expect(isCorruptionError(new Error('database disk image is malformed'))).toBe(true);
    expect(isCorruptionError(new Error('file is not a database'))).toBe(true);
  });

  it('rejects other errors and non-errors', () => {
    expect(isCorruptionError(new Error('SQLITE_BUSY: database is locked'))).toBe(false);
    expect(isCorruptionError(null)).toBe(false);
    expect(isCorruptionError(undefined)).toBe(false);
    expect(isCorruptionError('random string')).toBe(false);
  });
});

describe('noteOutboundCorruption', () => {
  it('does nothing before the streak threshold', () => {
    const session = makeSession();
    corruptOutboundDb(session);
    noteOutboundCorruption(session, corruptionErr());
    noteOutboundCorruption(session, corruptionErr());
    expect(bakFiles(session)).toHaveLength(0);
    expect(fs.readFileSync(outboundDbPath(AG, session.id), 'utf8')).toContain('not a sqlite database');
  });

  it('quarantines a genuinely corrupt DB on the third strike and recreates the schema', () => {
    const session = makeSession();
    corruptOutboundDb(session);
    for (let i = 0; i < 3; i++) noteOutboundCorruption(session, corruptionErr());

    expect(bakFiles(session)).toHaveLength(1);
    const db = new Database(outboundDbPath(AG, session.id), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });

  it('preserves the corrupt bytes in the backup file', () => {
    const session = makeSession();
    corruptOutboundDb(session);
    for (let i = 0; i < 3; i++) noteOutboundCorruption(session, corruptionErr());

    const bak = bakFiles(session)[0];
    expect(fs.readFileSync(path.join(sessionDir(AG, session.id), bak), 'utf8')).toContain('not a sqlite database');
  });

  it('leaves a healthy DB alone even at the streak threshold (quick_check passes)', () => {
    const session = makeSession(); // initSessionFolder created a valid outbound.db
    for (let i = 0; i < 3; i++) noteOutboundCorruption(session, corruptionErr());

    expect(bakFiles(session)).toHaveLength(0);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('resets the streak after quick_check passes, so healthy sessions never accumulate strikes', () => {
    const session = makeSession();
    for (let i = 0; i < 3; i++) noteOutboundCorruption(session, corruptionErr());
    // Now corrupt the file for real — the streak must start over from 0.
    corruptOutboundDb(session);
    noteOutboundCorruption(session, corruptionErr());
    noteOutboundCorruption(session, corruptionErr());
    expect(bakFiles(session)).toHaveLength(0);
    noteOutboundCorruption(session, corruptionErr());
    expect(bakFiles(session)).toHaveLength(1);
  });

  it('kills a running container first and quarantines from its exit callback', () => {
    const session = makeSession();
    corruptOutboundDb(session);
    isContainerRunning.mockReturnValue(true);
    let onExit: (() => void) | undefined;
    killContainer.mockImplementation((...args: unknown[]) => {
      onExit = args[2] as () => void;
    });

    for (let i = 0; i < 3; i++) noteOutboundCorruption(session, corruptionErr());

    expect(killContainer).toHaveBeenCalledTimes(1);
    // Not quarantined until the container is actually gone.
    expect(bakFiles(session)).toHaveLength(0);
    onExit?.();
    expect(bakFiles(session)).toHaveLength(1);
  });

  it('respawns the container after quarantine when inbound work is pending', () => {
    const session = makeSession();
    corruptOutboundDb(session);
    getSession.mockReturnValue(session);
    const inDb = new Database(inboundDbPath(AG, session.id));
    try {
      insertMessage(inDb, {
        id: 'msg-pending-1',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'telegram:1',
        channelType: 'telegram',
        threadId: null,
        content: JSON.stringify({ text: 'hi' }),
        processAfter: null,
        recurrence: null,
      });
    } finally {
      inDb.close();
    }

    for (let i = 0; i < 3; i++) noteOutboundCorruption(session, corruptionErr());

    expect(bakFiles(session)).toHaveLength(1);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('does not respawn when nothing is pending', () => {
    const session = makeSession();
    corruptOutboundDb(session);
    for (let i = 0; i < 3; i++) noteOutboundCorruption(session, corruptionErr());

    expect(bakFiles(session)).toHaveLength(1);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('noteOutboundReadOk resets the streak', () => {
    const session = makeSession();
    corruptOutboundDb(session);
    noteOutboundCorruption(session, corruptionErr());
    noteOutboundCorruption(session, corruptionErr());
    noteOutboundReadOk(session.id);
    noteOutboundCorruption(session, corruptionErr());
    expect(bakFiles(session)).toHaveLength(0);
  });
});

describe('handleContainerCorruptionExit (exit code 76 / corruption in stderr)', () => {
  const EXIT = {
    code: OUTBOUND_CORRUPTION_EXIT_CODE,
    stderrTail: ['[agent-runner] Fatal error: database disk image is malformed'],
  };

  it('recovers a genuinely corrupt DB immediately — no streak needed', () => {
    const session = makeSession();
    corruptOutboundDb(session);

    handleContainerCorruptionExit(session, EXIT);

    expect(bakFiles(session)).toHaveLength(1);
    const db = new Database(outboundDbPath(AG, session.id), { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('keeps session_state and messages_out rows when only data pages are damaged', () => {
    const session = makeSession();
    trashDataPages(session);

    handleContainerCorruptionExit(session, EXIT);

    expect(bakFiles(session)).toHaveLength(1);
    const db = new Database(outboundDbPath(AG, session.id), { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.prepare("SELECT value FROM session_state WHERE key = 'continuation:claude'").get()).toEqual({
        value: 'c1',
      });
      expect((db.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('leaves a healthy file alone when the container was wrong (stale in-container view)', () => {
    const session = makeSession();
    handleContainerCorruptionExit(session, EXIT);
    expect(bakFiles(session)).toHaveLength(0);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('resets the spawn backoff and respawns when inbound work is pending', () => {
    const session = makeSession();
    corruptOutboundDb(session);
    getSession.mockReturnValue(session);
    // Simulate the crash loop that led here: three early exits → held.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      spawnBackoff.recordExit(session.id, { code: 76, startedAt: now - 5000, now, stderrTail: EXIT.stderrTail });
    }
    expect(spawnBackoff.check(session.id, now).blocked).toBe(true);
    const inDb = new Database(inboundDbPath(AG, session.id));
    try {
      insertMessage(inDb, {
        id: 'msg-pending-76',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'telegram:1',
        channelType: 'telegram',
        threadId: null,
        content: JSON.stringify({ text: 'hi' }),
        processAfter: null,
        recurrence: null,
      });
    } finally {
      inDb.close();
    }

    handleContainerCorruptionExit(session, EXIT);

    expect(spawnBackoff.check(session.id, now).blocked).toBe(false);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when outbound.db does not exist yet', () => {
    const session = makeSession();
    fs.rmSync(outboundDbPath(AG, session.id));
    expect(() => handleContainerCorruptionExit(session, EXIT)).not.toThrow();
    expect(bakFiles(session)).toHaveLength(0);
  });
});

describe('stderrMentionsCorruption', () => {
  it('recognises the agent-runner fatal line and SQLITE_CORRUPT', () => {
    expect(stderrMentionsCorruption(['[agent-runner] Fatal error: database disk image is malformed'])).toBe(true);
    expect(stderrMentionsCorruption(['SqliteError: SQLITE_CORRUPT'])).toBe(true);
  });
  it('ignores unrelated stderr and undefined', () => {
    expect(stderrMentionsCorruption(['[poll-loop] Result: hello'])).toBe(false);
    expect(stderrMentionsCorruption(undefined)).toBe(false);
  });
});
