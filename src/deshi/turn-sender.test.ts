import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup } from '../db/messaging-groups.js';
import { createSession } from '../db/sessions.js';
import { upsertUser } from '../modules/permissions/db/users.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-turn-sender' };
});

const TEST_DIR = '/tmp/nanoclaw-test-turn-sender';
const AG = 'ag-1';
const SESSION = 'sess-1';

function now() {
  return new Date().toISOString();
}

/** ターンの入力を作る: inbound にメッセージを書き、processing 印を付ける。 */
async function seedTurn(messages: Array<{ id: string; kind?: string; content: Record<string, unknown> }>) {
  const { writeSessionMessage, openOutboundDbRw } = await import('../session-manager.js');
  for (const m of messages) {
    writeSessionMessage(AG, SESSION, {
      id: m.id,
      kind: (m.kind ?? 'chat') as 'chat',
      timestamp: now(),
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify(m.content),
    });
  }
  const db = openOutboundDbRw(AG, SESSION);
  try {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
    );
    for (const m of messages) stmt.run(m.id);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C1',
    name: 'lab',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  upsertUser({ id: 'slack:ADMIN', kind: 'slack', display_name: 'Admin', created_at: now() });
  upsertUser({ id: 'slack:GUEST', kind: 'slack', display_name: 'Guest', created_at: now() });
  createSession({
    id: SESSION,
    agent_group_id: AG,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  const { initSessionFolder } = await import('../session-manager.js');
  initSessionFolder(AG, SESSION);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

async function tokenFor(userId: string) {
  const { issueSenderToken } = await import('./sender-token.js');
  return issueSenderToken({
    userId,
    messagingGroupId: 'mg-1',
    agentGroupId: AG,
    sessionId: SESSION,
  });
}

describe('ターンの依頼者を特定する', () => {
  it('処理中の発言が1人分なら、その人を依頼者として返すこと', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');
    await seedTurn([{ id: 'm1', content: { text: '権限つけて', senderToken: await tokenFor('slack:ADMIN') } }]);

    expect(resolveTurnSender(AG, SESSION)).toEqual(expect.objectContaining({ ok: true, userId: 'slack:ADMIN' }));
  });

  it('同じ人が続けて発言していても、依頼者を特定できること', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');
    await seedTurn([
      { id: 'm1', content: { text: 'あのさ', senderToken: await tokenFor('slack:ADMIN') } },
      { id: 'm2', content: { text: '権限つけて', senderToken: await tokenFor('slack:ADMIN') } },
    ]);

    expect(resolveTurnSender(AG, SESSION)).toEqual(expect.objectContaining({ ok: true, userId: 'slack:ADMIN' }));
  });

  it('複数人の発言が混ざっているときは、依頼者を決めずに断ること', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');
    await seedTurn([
      { id: 'm1', content: { text: 'こんにちは', senderToken: await tokenFor('slack:GUEST') } },
      { id: 'm2', content: { text: '権限つけて', senderToken: await tokenFor('slack:ADMIN') } },
    ]);

    expect(resolveTurnSender(AG, SESSION)).toEqual({ ok: false, reason: 'mixed-senders' });
  });

  it('処理中の発言が無いときは、依頼者不明として断ること', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');

    expect(resolveTurnSender(AG, SESSION)).toEqual({ ok: false, reason: 'no-user-message' });
  });

  it('発言に発行の記録が無いときは、依頼者不明として断ること', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');
    await seedTurn([{ id: 'm1', content: { text: '権限つけて' } }]);

    expect(resolveTurnSender(AG, SESSION)).toEqual({ ok: false, reason: 'unresolved' });
  });

  it('身元の分からない人の発言が混ざっているときは、他が揃っていても断ること', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');
    await seedTurn([
      { id: 'm1', content: { text: 'こんにちは' } },
      { id: 'm2', content: { text: '権限つけて', senderToken: await tokenFor('slack:ADMIN') } },
    ]);

    expect(resolveTurnSender(AG, SESSION)).toEqual({ ok: false, reason: 'unresolved' });
  });

  it('期限切れの発言が混ざっているときは、他が揃っていても断ること', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');
    const { SENDER_TOKEN_TTL_MS } = await import('./sender-token.js');
    const { issueSenderToken } = await import('./sender-token.js');
    const stale = issueSenderToken({
      userId: 'slack:GUEST',
      messagingGroupId: 'mg-1',
      agentGroupId: AG,
      sessionId: SESSION,
      now: new Date(Date.now() - SENDER_TOKEN_TTL_MS - 1000),
    });
    await seedTurn([
      { id: 'm1', content: { text: 'こんにちは', senderToken: stale } },
      { id: 'm2', content: { text: '権限つけて', senderToken: await tokenFor('slack:ADMIN') } },
    ]);

    expect(resolveTurnSender(AG, SESSION)).toEqual({ ok: false, reason: 'expired' });
  });

  it('システムメッセージが混ざっていても、ユーザーの依頼者を特定できること', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');
    await seedTurn([{ id: 'm1', content: { text: '権限つけて', senderToken: await tokenFor('slack:ADMIN') } }]);
    await seedTurn([{ id: 'm2', kind: 'system', content: { text: 'CLI response' } }]);

    expect(resolveTurnSender(AG, SESSION)).toEqual(expect.objectContaining({ ok: true, userId: 'slack:ADMIN' }));
  });

  it('発言が古すぎるときは、依頼者を引けないものとして断ること', async () => {
    const { resolveTurnSender } = await import('./turn-sender.js');
    const { SENDER_TOKEN_TTL_MS } = await import('./sender-token.js');
    await seedTurn([{ id: 'm1', content: { text: '権限つけて', senderToken: await tokenFor('slack:ADMIN') } }]);

    const later = new Date(Date.now() + SENDER_TOKEN_TTL_MS + 1000);
    expect(resolveTurnSender(AG, SESSION, later)).toEqual({ ok: false, reason: 'expired' });
  });
});
