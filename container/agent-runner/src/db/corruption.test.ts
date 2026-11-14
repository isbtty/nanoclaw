/**
 * Exit-code diagnosis for session DB corruption (db/corruption.ts) and the
 * getOutboundDb() tagging that feeds it.
 *
 * The host only sees the container's exit code: 75 must mean "inbound view
 * poisoned, just remount", 76 must mean "outbound.db file is corrupt, recover
 * it before respawning". Getting that wrong either loops the session forever
 * (76 reported as 1/75) or quarantines a healthy file (75 reported as 76).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, getOutboundDb } from './connection.js';
import {
  corruptionExitCode,
  INBOUND_CORRUPTION_EXIT_CODE,
  isCorruptionError,
  OUTBOUND_CORRUPTION_EXIT_CODE,
  OutboundCorruptionError,
  outboundFileIsCorrupt,
} from './corruption.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-corruption-'));
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function healthyDb(): string {
  const p = path.join(dir, 'outbound.db');
  const db = new Database(p);
  db.exec('CREATE TABLE messages_out (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
  db.close();
  return p;
}

function garbageDb(): string {
  const p = path.join(dir, 'outbound.db');
  fs.writeFileSync(p, 'this is definitely not a sqlite database\0garbage'.repeat(100));
  return p;
}

/**
 * A valid 100-byte SQLite header followed by trashed pages: `new Database()`
 * succeeds, the first schema read/write fails with "database disk image is
 * malformed" — the shape of the production incidents (the file opened; the
 * startup CREATE TABLE / DELETE died).
 */
function torpedoedDb(): string {
  const p = healthyDb();
  const db = new Database(p);
  db.exec("INSERT INTO messages_out VALUES ('a', '" + 'x'.repeat(8000) + "')");
  db.close();
  const buf = fs.readFileSync(p);
  for (let i = 100; i < buf.length; i++) buf[i] = 0xa5;
  fs.writeFileSync(p, buf);
  return p;
}

/**
 * Only the data pages are trashed; page 1 (sqlite_master) is intact. Opening
 * and CREATE TABLE IF NOT EXISTS both succeed — only a later data read/write
 * or quick_check notices. Mirrors the freelist-only damage of 2026-11-07,
 * where the host's messages_out reads kept working.
 */
function dataPagesTrashedDb(): string {
  const p = healthyDb();
  const db = new Database(p);
  db.exec("INSERT INTO messages_out VALUES ('a', '" + 'x'.repeat(8000) + "')");
  db.close();
  const buf = fs.readFileSync(p);
  for (let i = 4096; i < buf.length; i++) buf[i] = 0xa5;
  fs.writeFileSync(p, buf);
  return p;
}

describe('isCorruptionError', () => {
  test('matches codes, messages and raw strings', () => {
    expect(isCorruptionError(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(true);
    expect(isCorruptionError(Object.assign(new Error('x'), { code: 'SQLITE_NOTADB' }))).toBe(true);
    expect(isCorruptionError(new Error('database disk image is malformed'))).toBe(true);
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  test('rejects other errors and empties', () => {
    expect(isCorruptionError(new Error('database is locked'))).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError(null)).toBe(false);
    expect(isCorruptionError(undefined)).toBe(false);
  });
});

describe('outboundFileIsCorrupt', () => {
  test('healthy file → false', () => {
    expect(outboundFileIsCorrupt(healthyDb())).toBe(false);
  });

  test('missing file → false (nothing to be corrupt yet)', () => {
    expect(outboundFileIsCorrupt(path.join(dir, 'nope.db'))).toBe(false);
  });

  test('not-a-database → true', () => {
    expect(outboundFileIsCorrupt(garbageDb())).toBe(true);
  });

  test('valid header, trashed pages → true', () => {
    expect(outboundFileIsCorrupt(torpedoedDb())).toBe(true);
  });

  test('intact schema page, trashed data pages → true (quick_check sees what CREATE TABLE misses)', () => {
    expect(outboundFileIsCorrupt(dataPagesTrashedDb())).toBe(true);
  });
});

describe('getOutboundDb on a corrupt file', () => {
  test('throws OutboundCorruptionError at open/init (the CREATE TABLE IF NOT EXISTS step)', () => {
    const p = torpedoedDb();
    let caught: unknown;
    try {
      getOutboundDb(p);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundCorruptionError);
    expect(isCorruptionError((caught as OutboundCorruptionError).cause)).toBe(true);
  });

  test('data-page-only damage opens fine; the first data write fails untagged and still maps to 76', () => {
    const p = dataPagesTrashedDb();
    const db = getOutboundDb(p); // open/init succeeds — schema page is intact
    let caught: unknown;
    try {
      db.exec("DELETE FROM messages_out WHERE id = 'a'");
    } catch (err) {
      caught = err;
    }
    expect(isCorruptionError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(OutboundCorruptionError);
    expect(corruptionExitCode(caught, p)).toBe(OUTBOUND_CORRUPTION_EXIT_CODE);
  });

  test('a healthy file opens and pins synchronous=FULL / journal_mode=DELETE', () => {
    const db = getOutboundDb(healthyDb());
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_state'").get()).toBeTruthy();
  });
});

describe('corruptionExitCode', () => {
  test('tagged outbound error → 76 regardless of the file', () => {
    expect(corruptionExitCode(new OutboundCorruptionError('t', new Error('x')), healthyDb())).toBe(
      OUTBOUND_CORRUPTION_EXIT_CODE,
    );
  });

  test('untagged corruption + corrupt outbound file → 76', () => {
    expect(corruptionExitCode(new Error('database disk image is malformed'), torpedoedDb())).toBe(
      OUTBOUND_CORRUPTION_EXIT_CODE,
    );
  });

  test('untagged corruption + healthy outbound file → 75 (inbound view)', () => {
    expect(corruptionExitCode(new Error('database disk image is malformed'), healthyDb())).toBe(
      INBOUND_CORRUPTION_EXIT_CODE,
    );
  });

  test('non-corruption error → null (plain exit 1)', () => {
    expect(corruptionExitCode(new Error('ECONNREFUSED'), healthyDb())).toBeNull();
  });
});
