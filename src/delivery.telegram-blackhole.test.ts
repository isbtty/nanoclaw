/**
 * B (isbtty/deshi#491) — faithful, isolated reproduction.
 *
 * Unlike delivery.test.ts, which injects a stub adapter that throws, this
 * wires the REAL vendored Telegram adapter (@chat-adapter/telegram) and the
 * REAL chat-sdk-bridge exactly as production does in index.ts — but points
 * `apiBaseUrl` at a black-hole endpoint (127.0.0.1:1 → ECONNREFUSED) so the
 * real `telegramFetch` throws a real NetworkError. This proves the network
 * fault the issue observed flows through the same code path
 * (telegramFetch → postMessage → postWithMarkdownFallback → deliver) into the
 * permanent-drop logic — no internet, no sudo, no live system touched.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTelegramAdapter } from '@chat-adapter/telegram';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-tg-blackhole' };
});
const TEST_DIR = '/tmp/nanoclaw-test-tg-blackhole';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { createChatSdkBridge } from './channels/chat-sdk-bridge.js';
import { resolveSession, outboundDbPath, openInboundDb } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Test', folder: 'test', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('B #491 — real Telegram adapter against a black-hole endpoint', () => {
  it('a real NetworkError from telegramFetch is treated as transient — retried, not dropped', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Insert a realistic final-answer message.
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
         VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
      )
      .run('out-final', JSON.stringify({ text: '今日の予定です：\n- 10:00 打合せ' }));
    outDb.close();

    // REAL adapter + REAL bridge, wired exactly like index.ts — but the API
    // base points at a closed port so every send fails with a real NetworkError.
    const telegramAdapter = createTelegramAdapter({
      botToken: 'test-token',
      apiBaseUrl: 'http://127.0.0.1:1',
      mode: 'polling', // inert until setup() — never called here
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      supportsThreads: false,
      maxTextLength: 4000,
    });

    const seen: unknown[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, platformId, threadId, kind, content, files) {
        try {
          return await bridge.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
        } catch (err) {
          seen.push(err);
          throw err; // propagate to delivery.ts retry path — same as production
        }
      },
    });

    // One drain against the black hole produces a real NetworkError.
    await deliverSessionMessages(session);

    // The failure is a genuine NetworkError originating in the vendored adapter.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const first = seen[0] as { name?: string; message?: string; stack?: string };
    const label = `${first?.name ?? ''} ${first?.message ?? ''} ${first?.stack ?? ''}`;
    expect(label).toMatch(/NetworkError|ECONNREFUSED|fetch failed|network/i);

    // #491 fix: a real network failure is transient — the message is NOT
    // dead-lettered (no row in delivered) and stays queued for retry.
    const inDb = openInboundDb('ag-1', session.id);
    const row = inDb.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get('out-final');
    inDb.close();
    expect(row).toBeUndefined();

    // Content still queued in messages_out for the next retry.
    const check = new Database(outboundDbPath('ag-1', session.id));
    const stillQueued = check.prepare('SELECT content FROM messages_out WHERE id = ?').get('out-final');
    check.close();
    expect(stillQueued).toBeDefined();
  }, 30_000);
});
