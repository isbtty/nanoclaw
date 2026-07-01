/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { resolveSession, outboundDbPath, openInboundDb } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  insertOutboundAt(agentGroupId, sessionId, msgId, "datetime('now')");
}

/** Insert an outbound message with an explicit SQL timestamp expression (e.g.
 *  "datetime('now','-7 hours')") to exercise the transient time ceiling. */
function insertOutboundAt(agentGroupId: string, sessionId: string, msgId: string, timestampSql: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ${timestampSql}, 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

/** A transient (retryable) failure, shaped like the vendored adapter's NetworkError. */
function networkError(): Error {
  const e = new Error('Network error calling Telegram sendMessage');
  e.name = 'NetworkError';
  return e;
}

/** A permanent adapter failure, matched by name in isPermanentError. */
function permanentAdapterError(): Error {
  const e = new Error('Message text exceeds limit');
  e.name = 'ValidationError';
  return e;
}

function deliveredStatus(agentGroupId: string, sessionId: string, msgId: string): string | undefined {
  const inDb = openInboundDb(agentGroupId, sessionId);
  const row = inDb.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(msgId) as
    | { status: string }
    | undefined;
  inDb.close();
  return row?.status;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });
});

describe('deliverSessionMessages — retry and permanent failure', () => {
  // #491 fix (was REPRO #491): a transient outage spanning several attempts no
  // longer drops the message. With attempt-count retries removed, delivery keeps
  // retrying under backoff and succeeds once the network recovers — the exact
  // case the old 3-attempt/2.5s window lost forever.
  it('#491 fix: a transient outage is retried with backoff and eventually delivered', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-blip');

    let callCount = 0;
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        callCount++;
        if (callCount <= 3) throw networkError(); // blip spans attempts 1-3
        delivered.push(content);
        return 'plat-recovered';
      },
    });

    vi.useFakeTimers();
    try {
      await deliverSessionMessages(session); // attempt 1 — fails, backoff ~1s
      expect(callCount).toBe(1);

      // An immediate re-drain is throttled by backoff — no new attempt.
      await deliverSessionMessages(session);
      expect(callCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await deliverSessionMessages(session); // attempt 2 — fails, backoff ~2s
      expect(callCount).toBe(2);

      await vi.advanceTimersByTimeAsync(2000);
      await deliverSessionMessages(session); // attempt 3 — fails, backoff ~4s
      expect(callCount).toBe(3);

      await vi.advanceTimersByTimeAsync(4000);
      await deliverSessionMessages(session); // attempt 4 — network recovered → delivered
      expect(callCount).toBe(4);
    } finally {
      vi.useRealTimers();
    }

    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]!).text).toBe('hello');
    // Terminal state is 'delivered', not 'failed' — nothing was dropped.
    expect(deliveredStatus('ag-1', session.id, 'out-blip')).toBe('delivered');
  });

  it('#491 fix: a permanent error dead-letters immediately without retrying', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-perm');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw permanentAdapterError();
      },
    });

    await deliverSessionMessages(session); // dead-lettered on the first failure
    expect(callCount).toBe(1);
    await deliverSessionMessages(session); // not retried — already terminal
    expect(callCount).toBe(1);

    expect(deliveredStatus('ag-1', session.id, 'out-perm')).toBe('failed');
  });

  it('#491 fix: a transient failure that never recovers dead-letters after the time ceiling', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // Queued 7h ago — already past the 6h transient ceiling.
    insertOutboundAt('ag-1', session.id, 'out-old', "datetime('now','-7 hours')");

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw networkError();
      },
    });

    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Bounded: a channel broken for hours dead-letters instead of retrying forever.
    expect(deliveredStatus('ag-1', session.id, 'out-old')).toBe('failed');
  });
});

describe('deliverSessionMessages — permission check', () => {
  it('rejects delivery to an unauthorized channel destination', async () => {
    seedAgentAndChannel();

    // Create a second messaging group that the agent is NOT wired to
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'discord:456',
      name: 'Unauthorized Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // Session is on mg-1 (telegram)
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Insert an outbound message targeting mg-2 (discord) — not the origin chat
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'discord:456', 'discord', ?)`,
      )
      .run('out-unauth', JSON.stringify({ text: 'sneaky' }));
    outDb.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-msg';
      },
    });

    // Unauthorized is a PermanentDeliveryError → dead-lettered on the first
    // failure, not retried.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // Adapter never called — permission check throws before reaching it
    expect(calls).toHaveLength(0);

    // Message is marked as permanently failed
    expect(deliveredStatus('ag-1', session.id, 'out-unauth')).toBe('failed');
  });
});
