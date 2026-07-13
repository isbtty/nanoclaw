/**
 * Unit coverage for the thread-backfill support helpers on session-manager:
 * the once-only marker and the earliest-inbound-ts boundary. Both drive the
 * router's decision to fetch a thread's pre-history exactly once per session
 * and only for the messages the session hasn't already seen.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-thread-backfill' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import {
  initSessionFolder,
  writeSessionMessage,
  earliestInboundTs,
  hasBackfilledThread,
  markThreadBackfilled,
} from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-thread-backfill';
const AG = 'ag-backfill';
const SESS = 'sess-backfill';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'Backfill', folder: 'backfill', agent_provider: null, created_at: now() });
  const sess: Session = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('thread-backfilled marker', () => {
  it('is absent until marked, then present (idempotent)', () => {
    expect(hasBackfilledThread(AG, SESS)).toBe(false);
    markThreadBackfilled(AG, SESS);
    expect(hasBackfilledThread(AG, SESS)).toBe(true);
    markThreadBackfilled(AG, SESS); // second call is a no-op
    expect(hasBackfilledThread(AG, SESS)).toBe(true);
  });
});

describe('earliestInboundTs', () => {
  it('returns null for a session with no messages', () => {
    expect(earliestInboundTs(AG, SESS)).toBeNull();
  });

  it('returns the bare ts of the earliest message (id is <ts>:<agentGroupId>)', () => {
    // Written out of order — earliest by insertion is what we expect back,
    // since messages_in.seq is monotonic in write order.
    for (const ts of ['1782511706.000000', '1783906128.393849']) {
      writeSessionMessage(AG, SESS, {
        id: `${ts}:${AG}`,
        kind: 'chat',
        timestamp: now(),
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: 'slack:C1:1782511706.000000',
        content: JSON.stringify({ text: 'hi' }),
      });
    }
    expect(earliestInboundTs(AG, SESS)).toBe('1782511706.000000');
  });

  it('returns null when the earliest id is not a bare ts', () => {
    writeSessionMessage(AG, SESS, {
      id: 'a2a-synthetic-id',
      kind: 'chat',
      timestamp: now(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ text: 'hi' }),
    });
    expect(earliestInboundTs(AG, SESS)).toBeNull();
  });
});
