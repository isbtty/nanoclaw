/**
 * in-flight job 永続化ストアの単体テスト (isbtty/deshi#523 対応策5)。
 *
 * respawn 越しの復元は live e2e では再現しづらいので、save→load round-trip、
 * clear、欠損 / 破損入力の扱いをここで決定的に固定する。bun:test で実行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadInflightJob, saveInflightJob, clearInflightJob } from './inflight-job-store.js';
import type { LastRunStart } from './run-start-guard.js';

let dir: string;
let path: string;
const rec: LastRunStart = { triggerSeq: 7, jobId: 'job-abc', threadId: 't-1' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inflight-'));
  path = join(dir, 'nested', 'last-run-start.json'); // nested → mkdir 挙動も検証
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('saveInflightJob / loadInflightJob', () => {
  it('round-trips the record (creating parent dirs)', () => {
    saveInflightJob(path, rec);
    expect(existsSync(path)).toBe(true);
    expect(loadInflightJob(path)).toEqual(rec);
  });

  it('overwrites a previous record', () => {
    saveInflightJob(path, rec);
    const next: LastRunStart = { triggerSeq: 8, jobId: 'job-xyz', threadId: 't-2' };
    saveInflightJob(path, next);
    expect(loadInflightJob(path)).toEqual(next);
  });
});

describe('loadInflightJob — missing / corrupt', () => {
  it('returns null when the file does not exist', () => {
    expect(loadInflightJob(path)).toBeNull();
  });

  it('returns null on non-JSON content', () => {
    writeFileSync(path.replace('/nested', ''), 'not json{');
    expect(loadInflightJob(path.replace('/nested', ''))).toBeNull();
  });

  it('returns null when required fields are missing or wrong type', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, JSON.stringify({ triggerSeq: 'nope', jobId: 'x', threadId: 't' }));
    expect(loadInflightJob(p)).toBeNull();
  });

  it('returns null when jobId is empty', () => {
    const p = join(dir, 'empty.json');
    writeFileSync(p, JSON.stringify({ triggerSeq: 1, jobId: '', threadId: 't' }));
    expect(loadInflightJob(p)).toBeNull();
  });
});

describe('clearInflightJob', () => {
  it('removes the file so a subsequent load returns null', () => {
    saveInflightJob(path, rec);
    clearInflightJob(path);
    expect(existsSync(path)).toBe(false);
    expect(loadInflightJob(path)).toBeNull();
  });

  it('is a no-op when the file is already absent', () => {
    expect(() => clearInflightJob(path)).not.toThrow();
  });
});
