/**
 * Data-preserving outbound.db recovery (src/outbound-recovery.ts).
 *
 * The headline test runs against the *real* corrupt file kept from the
 * 2026-11-07 takbot-group incident (freelist damage, every row still
 * readable): session_state (provider continuation) and messages_out must
 * survive via `.recover`, and again via the better-sqlite3 row-copy fallback
 * when no sqlite3 CLI is available. The file is copied into a temp dir; the
 * live session directory is never touched. Skipped when the sample isn't on
 * this machine (CI) — the synthetic cases below still run.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema } from './db/session-db.js';
import { findSqlite3Bin, integrityOk, recoverOutboundDb, RECOVERY_TABLE_ORDER } from './outbound-recovery.js';

const INCIDENT_SAMPLE = path.join(
  os.homedir(),
  'code/nanoclaw/data/v2-sessions/ag-1780216909922-7e8236/sess-1780217651807-2io05h/outbound.db.corrupt-20261108-141649',
);
const haveSample = fs.existsSync(INCIDENT_SAMPLE);
const haveSqlite3 = findSqlite3Bin() !== null;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-outbound-recovery-'));
  dbPath = path.join(dir, 'outbound.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openRo(p: string): Database.Database {
  return new Database(p, { readonly: true });
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function bakFiles(): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes('.corrupt-') && f.endsWith('.bak'));
}

/** Healthy outbound.db with known rows, then page-1-only survives (data pages trashed). */
function seedAndTrash(): { seq: number } {
  ensureSchema(dbPath, 'outbound');
  const db = new Database(dbPath);
  db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
    'continuation:claude',
    'conv-123',
    '2026-11-07T14:17:49.166Z',
  );
  for (let i = 1; i <= 50; i++) {
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, ?, ?, 'chat', 'telegram:1', 'telegram', ?)`,
    ).run(`m${i}`, i * 2 + 1, new Date().toISOString(), JSON.stringify({ text: 'x'.repeat(2000) }));
  }
  db.close();
  return { seq: 101 };
}

describe('recoverOutboundDb — incident sample (2026-11-07 takbot-group)', () => {
  it.skipIf(!haveSample || !haveSqlite3)(
    'sqlite3 .recover keeps session_state and messages_out, integrity ok, original kept as .bak',
    () => {
      fs.copyFileSync(INCIDENT_SAMPLE, dbPath);
      expect(integrityOk(dbPath)).toBe(false); // sanity: the sample really is corrupt

      const result = recoverOutboundDb(dbPath);

      expect(result.method).toBe('sqlite3-recover');
      expect(integrityOk(dbPath)).toBe(true);
      expect(bakFiles()).toHaveLength(1);
      expect(fs.statSync(result.backupPath).size).toBe(fs.statSync(INCIDENT_SAMPLE).size);

      const db = openRo(dbPath);
      try {
        const states = db.prepare('SELECT key, value FROM session_state ORDER BY key').all() as Array<{
          key: string;
          value: string;
        }>;
        expect(states.map((s) => s.key)).toEqual(['continuation:claude', 'current_in_reply_to']);
        expect(states[0].value).toMatch(/^[0-9a-f-]{36}$/); // the provider continuation id
        expect(count(db, 'messages_out')).toBeGreaterThanOrEqual(4600);
        expect(count(db, 'processing_ack')).toBeGreaterThanOrEqual(4100);
        expect(count(db, 'container_state')).toBe(1);
        expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
      } finally {
        db.close();
      }
      expect(result.tables.session_state.recovered).toBe(2);
      expect(result.tables.messages_out.dropped).toBe(0);
    },
  );

  it.skipIf(!haveSample)('row-copy fallback (no sqlite3 CLI) also keeps session_state and messages_out', () => {
    fs.copyFileSync(INCIDENT_SAMPLE, dbPath);

    const result = recoverOutboundDb(dbPath, { sqlite3Bin: null });

    expect(result.method).toBe('row-copy');
    expect(result.attempts).toContain('sqlite3 CLI not available');
    expect(integrityOk(dbPath)).toBe(true);
    const db = openRo(dbPath);
    try {
      expect(count(db, 'session_state')).toBe(2);
      expect(count(db, 'messages_out')).toBeGreaterThanOrEqual(4600);
    } finally {
      db.close();
    }
  });
});

describe('recoverOutboundDb — synthetic cases', () => {
  it('garbage file falls through every method to an empty schema, keeping the bytes in .bak', () => {
    fs.writeFileSync(dbPath, 'this is definitely not a sqlite database\0garbage');
    fs.writeFileSync(`${dbPath}-journal`, 'stale journal');

    const result = recoverOutboundDb(dbPath);

    expect(result.method).toBe('empty');
    expect(integrityOk(dbPath)).toBe(true);
    expect(bakFiles()).toHaveLength(1);
    expect(fs.readFileSync(result.backupPath, 'utf8')).toContain('not a sqlite database');
    // Journal travels with the backup so it is never replayed into the new file.
    expect(fs.existsSync(`${result.backupPath}-journal`)).toBe(true);
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(false);
    const db = openRo(dbPath);
    try {
      for (const t of RECOVERY_TABLE_ORDER) expect(count(db, t)).toBe(0);
    } finally {
      db.close();
    }
    // No scratch files left behind.
    expect(fs.readdirSync(dir).filter((f) => f.includes('.recovering-'))).toHaveLength(0);
  });

  it('row-copy keeps the rows on intact pages and reports what it dropped', () => {
    seedAndTrash();
    // Trash the tail of the file: later messages_out leaf pages die, page 1
    // (schema) and the first data pages survive.
    const buf = fs.readFileSync(dbPath);
    const cut = Math.floor(buf.length * 0.6);
    for (let i = cut; i < buf.length; i++) buf[i] = 0xa5;
    fs.writeFileSync(dbPath, buf);
    expect(integrityOk(dbPath)).toBe(false);

    const result = recoverOutboundDb(dbPath, { sqlite3Bin: null });

    expect(['row-copy', 'empty']).toContain(result.method);
    expect(integrityOk(dbPath)).toBe(true);
    const db = openRo(dbPath);
    try {
      if (result.method === 'row-copy') {
        // Whatever survived is consistent; session_state lives on an early page.
        expect(count(db, 'session_state')).toBe(1);
        expect(count(db, 'messages_out')).toBeGreaterThan(0);
        expect(count(db, 'messages_out')).toBeLessThan(50);
      }
    } finally {
      db.close();
    }
  });

  it.skipIf(!haveSqlite3)('a healthy file round-trips through .recover unchanged', () => {
    seedAndTrash();
    const result = recoverOutboundDb(dbPath);
    expect(result.method).toBe('sqlite3-recover');
    const db = openRo(dbPath);
    try {
      expect(count(db, 'messages_out')).toBe(50);
      expect(count(db, 'session_state')).toBe(1);
      // ensureSchema afterwards means every outbound table exists even if
      // the source predates one of them.
      for (const t of RECOVERY_TABLE_ORDER) expect(() => count(db, t)).not.toThrow();
    } finally {
      db.close();
    }
    expect(result.lostAndFound).toBe(0);
  });

  it('throws (and leaves the file alone) when the quarantine rename itself fails', () => {
    expect(() => recoverOutboundDb(path.join(dir, 'does-not-exist.db'))).toThrow();
    expect(bakFiles()).toHaveLength(0);
  });
});
