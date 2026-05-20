/**
 * Unit tests for skill-execution-notifications inbound handler.
 *
 * テスト方針 (issue #247 のテスト観点を踏襲):
 *
 *   - validation 系 (400): channel / chatId / message / files の必須性 + 型
 *   - lookup 系 (404): messaging_group 未登録 / agent 未 wiring
 *   - 正常系: session 解決 → messages_out 書き込み (DM)
 *   - threadId 指定 + per-thread session 引き
 *   - effectiveSessionMode の境界:
 *     * DM (is_group=0): per-thread に倒れない (supportsThreads でも)
 *     * group + supportsThreads=true: per-thread に強制
 *     * group + supportsThreads=false: wiring の session_mode 通り
 *   - files: base64 → outbox/<id>/<filename> に書かれ、messages_out.content
 *     の files[] にも載る
 *
 * テスト基盤は src/delivery.test.ts と同じパターン:
 *   - vi.mock で DATA_DIR を /tmp 配下に差し替え (cross-mount を起こさない)
 *   - initTestDb + runMigrations で中央 DB を in-memory で起動
 *   - 各 it の前に seed (agent_group + messaging_group + wiring)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-inbound' };
});

const TEST_DIR = '/tmp/nanoclaw-test-inbound';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../../db/index.js';
import { inboundDbPath, outboundDbPath, sessionDir } from '../../session-manager.js';
import {
  skillExecutionNotificationsHandler,
  type SkillExecutionNotificationResponse,
} from './skill-execution-notifications.js';

function now(): string {
  return new Date().toISOString();
}

interface MessagesOutRow {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

function readMessagesOut(agentGroupId: string, sessionId: string): MessagesOutRow[] {
  const db = new Database(outboundDbPath(agentGroupId, sessionId), { readonly: true });
  try {
    return db
      .prepare('SELECT id, kind, platform_id, channel_type, thread_id, content FROM messages_out ORDER BY seq ASC')
      .all() as MessagesOutRow[];
  } finally {
    db.close();
  }
}

interface MessagesInRow {
  id: string;
  kind: string;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

function readMessagesIn(agentGroupId: string, sessionId: string): MessagesInRow[] {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  try {
    return db
      .prepare(
        'SELECT id, kind, trigger, platform_id, channel_type, thread_id, content FROM messages_in ORDER BY seq ASC',
      )
      .all() as MessagesInRow[];
  } finally {
    db.close();
  }
}

function seedAgentAndChannel(
  opts: {
    agentId?: string;
    mgId?: string;
    channelType?: string;
    platformId?: string;
    isGroup?: 0 | 1;
    sessionMode?: 'shared' | 'per-thread' | 'agent-shared';
  } = {},
): { agentId: string; mgId: string } {
  const agentId = opts.agentId ?? 'ag-1';
  const mgId = opts.mgId ?? 'mg-1';
  createAgentGroup({
    id: agentId,
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: mgId,
    channel_type: opts.channelType ?? 'telegram',
    platform_id: opts.platformId ?? 'tg:chat-1',
    name: 'Test Chat',
    is_group: opts.isGroup ?? 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: `mga-${mgId}-${agentId}`,
    messaging_group_id: mgId,
    agent_group_id: agentId,
    engage_mode: 'pattern',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: opts.sessionMode ?? 'shared',
    priority: 0,
    created_at: now(),
  });
  return { agentId, mgId };
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

describe('skillExecutionNotificationsHandler — validation', () => {
  it('rejects non-object body with 400', async () => {
    await expect(skillExecutionNotificationsHandler(null)).rejects.toMatchObject({
      status: 400,
      message: 'request body must be a JSON object',
    });
    await expect(skillExecutionNotificationsHandler('string')).rejects.toMatchObject({
      status: 400,
      message: 'request body must be a JSON object',
    });
  });

  it('rejects missing channel with 400', async () => {
    await expect(skillExecutionNotificationsHandler({ chatId: 'x', message: 'hi' })).rejects.toMatchObject({
      status: 400,
      message: 'channel is required',
    });
  });

  it('rejects missing chatId with 400', async () => {
    await expect(skillExecutionNotificationsHandler({ channel: 'telegram', message: 'hi' })).rejects.toMatchObject({
      status: 400,
      message: 'chatId is required',
    });
  });

  it('rejects missing message with 400', async () => {
    await expect(skillExecutionNotificationsHandler({ channel: 'telegram', chatId: 'x' })).rejects.toMatchObject({
      status: 400,
      message: 'message is required',
    });
  });

  it('rejects non-string threadId with 400', async () => {
    seedAgentAndChannel();
    await expect(
      skillExecutionNotificationsHandler({
        channel: 'telegram',
        chatId: 'tg:chat-1',
        threadId: 123,
        message: 'hi',
      }),
    ).rejects.toMatchObject({ status: 400, message: 'threadId must be string or null' });
  });

  it('rejects malformed files array with 400', async () => {
    seedAgentAndChannel();
    await expect(
      skillExecutionNotificationsHandler({
        channel: 'telegram',
        chatId: 'tg:chat-1',
        message: 'hi',
        files: 'not-an-array',
      }),
    ).rejects.toMatchObject({ status: 400, message: 'files must be an array' });

    await expect(
      skillExecutionNotificationsHandler({
        channel: 'telegram',
        chatId: 'tg:chat-1',
        message: 'hi',
        files: [{ contentBase64: 'AAA' }],
      }),
    ).rejects.toMatchObject({ status: 400, message: 'files[0].filename is required' });
  });

  it('rejects unsafe filename with 400 (path traversal)', async () => {
    seedAgentAndChannel();
    await expect(
      skillExecutionNotificationsHandler({
        channel: 'telegram',
        chatId: 'tg:chat-1',
        message: 'hi',
        files: [{ filename: '../escape.txt', contentBase64: 'AAA' }],
      }),
    ).rejects.toMatchObject({ status: 400, message: 'unsafe filename: ../escape.txt' });
  });
});

describe('skillExecutionNotificationsHandler — lookup failures', () => {
  it('returns 404 when messaging_group not registered', async () => {
    seedAgentAndChannel();
    await expect(
      skillExecutionNotificationsHandler({
        channel: 'telegram',
        chatId: 'unknown',
        message: 'hi',
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: 'messaging_group not found for telegram/unknown',
    });
  });

  it('returns 404 when agent not wired to messaging_group', async () => {
    // messaging_group のみ作って wiring を作らない
    createMessagingGroup({
      id: 'mg-orphan',
      channel_type: 'telegram',
      platform_id: 'tg:orphan',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await expect(
      skillExecutionNotificationsHandler({
        channel: 'telegram',
        chatId: 'tg:orphan',
        message: 'hi',
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: 'no agent wired to messaging_group mg-orphan',
    });
  });
});

describe('skillExecutionNotificationsHandler — happy path (DM)', () => {
  it('writes messages_out row and returns sessionId + messageId', async () => {
    const { agentId } = seedAgentAndChannel();

    const result = (await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: '完了しました',
    })) as SkillExecutionNotificationResponse;

    expect(result.ok).toBe(true);
    expect(result.sessionId).toMatch(/^sess-/);
    expect(result.messageId).toMatch(/^deshi-inbound-/);

    const rows = readMessagesOut(agentId, result.sessionId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('chat');
    expect(row.channel_type).toBe('telegram');
    expect(row.platform_id).toBe('tg:chat-1');
    expect(row.thread_id).toBeNull(); // DM、threadId 未指定
    const content = JSON.parse(row.content) as { text: string; files: string[] };
    expect(content.text).toBe('完了しました');
    expect(content.files).toEqual([]);
  });

  it('reuses existing session on repeated calls (shared mode)', async () => {
    const { agentId } = seedAgentAndChannel();

    const first = (await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: 'first',
    })) as SkillExecutionNotificationResponse;

    const second = (await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: 'second',
    })) as SkillExecutionNotificationResponse;

    expect(second.sessionId).toBe(first.sessionId);
    const rows = readMessagesOut(agentId, first.sessionId);
    expect(rows.map((r) => JSON.parse(r.content).text)).toEqual(['first', 'second']);
  });
});

describe('skillExecutionNotificationsHandler — files (base64 → outbox)', () => {
  it('decodes base64 and writes files into outbox/<id>/<filename>', async () => {
    const { agentId } = seedAgentAndChannel();

    const payload = Buffer.from('hello world');
    const result = (await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: '添付テスト',
      files: [{ filename: 'arch.png', contentBase64: payload.toString('base64') }],
    })) as SkillExecutionNotificationResponse;

    // outbox に物理ファイルが書かれている
    const outboxPath = path.join(sessionDir(agentId, result.sessionId), 'outbox', result.messageId, 'arch.png');
    expect(fs.existsSync(outboxPath)).toBe(true);
    expect(fs.readFileSync(outboxPath)).toEqual(payload);

    // messages_out.content.files にも declare されている
    const rows = readMessagesOut(agentId, result.sessionId);
    const content = JSON.parse(rows[0]!.content) as { text: string; files: string[] };
    expect(content.files).toEqual(['arch.png']);
  });
});

describe('skillExecutionNotificationsHandler — effectiveSessionMode boundaries', () => {
  // 同じ chatId に対して (threadId=A) と (threadId=B) で別 session ができるか
  // (= per-thread として振る舞っているか) を確認するヘルパ
  async function sessionsByThread(opts: {
    channel: string;
    chatId: string;
    threadIdA: string | null;
    threadIdB: string | null;
  }): Promise<{ sessionA: string; sessionB: string }> {
    const a = (await skillExecutionNotificationsHandler({
      channel: opts.channel,
      chatId: opts.chatId,
      threadId: opts.threadIdA,
      message: 'a',
    })) as SkillExecutionNotificationResponse;
    const b = (await skillExecutionNotificationsHandler({
      channel: opts.channel,
      chatId: opts.chatId,
      threadId: opts.threadIdB,
      message: 'b',
    })) as SkillExecutionNotificationResponse;
    return { sessionA: a.sessionId, sessionB: b.sessionId };
  }

  it('DM (is_group=0) collapses threads — same session even with different threadIds', async () => {
    // Telegram DM: SUPPORTS_THREADS=false なので是非以前に is_group=0 で
    // 必ず shared に倒れる
    seedAgentAndChannel({ channelType: 'telegram', platformId: 'tg:dm', isGroup: 0 });
    const { sessionA, sessionB } = await sessionsByThread({
      channel: 'telegram',
      chatId: 'tg:dm',
      threadIdA: 'topic-A',
      threadIdB: 'topic-B',
    });
    expect(sessionA).toBe(sessionB);
  });

  it('group + supportsThreads=true (slack) forces per-thread', async () => {
    // Slack group: SUPPORTS_THREADS=true + is_group=1 → router の強制
    // override が効いて wiring が shared でも per-thread になる
    seedAgentAndChannel({
      channelType: 'slack',
      platformId: 'slack:C123',
      isGroup: 1,
      sessionMode: 'shared',
    });
    const { sessionA, sessionB } = await sessionsByThread({
      channel: 'slack',
      chatId: 'slack:C123',
      threadIdA: '1700000000.000001',
      threadIdB: '1700000000.000002',
    });
    expect(sessionA).not.toBe(sessionB);
  });

  it('group + supportsThreads=false (telegram group) follows wiring (shared)', async () => {
    // Telegram group: SUPPORTS_THREADS=false なので強制 override 無し、
    // wiring が shared なら threadId 違いでも同じ session
    seedAgentAndChannel({
      channelType: 'telegram',
      platformId: 'tg:group',
      isGroup: 1,
      sessionMode: 'shared',
    });
    const { sessionA, sessionB } = await sessionsByThread({
      channel: 'telegram',
      chatId: 'tg:group',
      threadIdA: 'topic-A',
      threadIdB: 'topic-B',
    });
    expect(sessionA).toBe(sessionB);
  });

  it('agent-shared mode is preserved even on threaded adapter', async () => {
    // agent-shared は upstream の override 対象外。slack でも維持される
    seedAgentAndChannel({
      channelType: 'slack',
      platformId: 'slack:C999',
      isGroup: 1,
      sessionMode: 'agent-shared',
    });
    const { sessionA, sessionB } = await sessionsByThread({
      channel: 'slack',
      chatId: 'slack:C999',
      threadIdA: 't1',
      threadIdB: 't2',
    });
    expect(sessionA).toBe(sessionB);
  });

  it('threadId is propagated to messages_out.thread_id', async () => {
    const { agentId } = seedAgentAndChannel({
      channelType: 'slack',
      platformId: 'slack:Cx',
      isGroup: 1,
      sessionMode: 'shared',
    });
    const result = (await skillExecutionNotificationsHandler({
      channel: 'slack',
      chatId: 'slack:Cx',
      threadId: 'thr-42',
      message: 'reply',
    })) as SkillExecutionNotificationResponse;

    const rows = readMessagesOut(agentId, result.sessionId);
    expect(rows[0]!.thread_id).toBe('thr-42');
  });
});

/**
 * ADR-0011 パターン A: messages_out (即時配信) と messages_in (context 注入)
 * の両方に書き込まれることを検証する。
 *
 * messages_in 側は:
 *  - kind = 'webhook' (formatter が <webhook> XML タグで整形)
 *  - trigger = 0 (host countDueMessages がカウントせず、agent を起床させない)
 *  - content は { source, event, payload: {text, files} } JSON
 */
describe('skillExecutionNotificationsHandler — messages_in context injection (ADR-0011)', () => {
  it('writes a corresponding messages_in row with kind=webhook + trigger=0', async () => {
    const { agentId } = seedAgentAndChannel();

    const result = (await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: '完了しました',
    })) as SkillExecutionNotificationResponse;

    const inRows = readMessagesIn(agentId, result.sessionId);
    // messages_in は他のソース (router 等) からも書かれうるので、本 handler 由来の
    // webhook 行だけを取り出して検証する
    const webhookRows = inRows.filter((r) => r.kind === 'webhook');
    expect(webhookRows).toHaveLength(1);

    const row = webhookRows[0]!;
    expect(row.trigger).toBe(0); // ← 起床させない (ADR-0011 の肝)
    expect(row.channel_type).toBe('telegram');
    expect(row.platform_id).toBe('tg:chat-1');
    expect(row.thread_id).toBeNull();

    // content schema は { source, event, payload: { text, files } }
    const content = JSON.parse(row.content) as {
      source: string;
      event: string;
      payload: { text: string; files: string[] };
    };
    expect(content.source).toBe('deshi');
    expect(content.event).toBe('skill-execution-result');
    expect(content.payload.text).toBe('完了しました');
    expect(content.payload.files).toEqual([]);
  });

  it('messages_in row id is derived from messageId (suffix `-in`) so both rows can be correlated', async () => {
    const { agentId } = seedAgentAndChannel();

    const result = (await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: 'correlate me',
    })) as SkillExecutionNotificationResponse;

    const inRows = readMessagesIn(agentId, result.sessionId).filter((r) => r.kind === 'webhook');
    expect(inRows[0]!.id).toBe(`${result.messageId}-in`);
  });

  it('writes messages_out AND messages_in atomically for each call (shared session reuse)', async () => {
    const { agentId } = seedAgentAndChannel();

    await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: 'first',
    });
    const result2 = (await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: 'second',
    })) as SkillExecutionNotificationResponse;

    const outRows = readMessagesOut(agentId, result2.sessionId);
    const inWebhookRows = readMessagesIn(agentId, result2.sessionId).filter((r) => r.kind === 'webhook');

    expect(outRows.map((r) => JSON.parse(r.content).text)).toEqual(['first', 'second']);
    expect(inWebhookRows.map((r) => JSON.parse(r.content).payload.text)).toEqual(['first', 'second']);
    // すべての messages_in webhook 行が trigger=0 であること (起床しない)
    expect(inWebhookRows.every((r) => r.trigger === 0)).toBe(true);
  });

  it('payload.files mirrors the outbox filenames (only names, not binary)', async () => {
    const { agentId } = seedAgentAndChannel();

    const payload = Buffer.from('binary content');
    const result = (await skillExecutionNotificationsHandler({
      channel: 'telegram',
      chatId: 'tg:chat-1',
      message: 'ファイル付き',
      files: [{ filename: 'report.pdf', contentBase64: payload.toString('base64') }],
    })) as SkillExecutionNotificationResponse;

    const inRows = readMessagesIn(agentId, result.sessionId).filter((r) => r.kind === 'webhook');
    const content = JSON.parse(inRows[0]!.content) as {
      payload: { text: string; files: string[] };
    };
    expect(content.payload.files).toEqual(['report.pdf']);
    // messages_in の content には base64 binary を含めない (= 重複保存しない)
    expect(JSON.stringify(content)).not.toContain(payload.toString('base64'));
  });

  it('messages_in thread_id mirrors the messages_out routing', async () => {
    const { agentId } = seedAgentAndChannel({
      channelType: 'slack',
      platformId: 'slack:Cx',
      isGroup: 1,
      sessionMode: 'shared',
    });
    const result = (await skillExecutionNotificationsHandler({
      channel: 'slack',
      chatId: 'slack:Cx',
      threadId: 'thr-77',
      message: 'reply with thread',
    })) as SkillExecutionNotificationResponse;

    const inRows = readMessagesIn(agentId, result.sessionId).filter((r) => r.kind === 'webhook');
    expect(inRows[0]!.thread_id).toBe('thr-77');
  });
});
