import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup } from '../db/messaging-groups.js';
import { createSession } from '../db/sessions.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-permission-gate' };
});

const TEST_DIR = '/tmp/nanoclaw-test-permission-gate';
const AG = 'ag-lab';
const SESSION = 'sess-1';

function now() {
  return new Date().toISOString();
}

/** そのターンの入力として、指定ユーザーの発話を 1 件置く。 */
async function seedTurnFrom(userId: string | null, messageId = 'm1') {
  const { writeSessionMessage, openOutboundDbRw } = await import('../session-manager.js');
  const { issueSenderToken } = await import('./sender-token.js');
  const content: Record<string, unknown> = { text: '権限つけて' };
  if (userId) {
    content.senderToken = issueSenderToken({
      userId,
      messagingGroupId: 'mg-1',
      agentGroupId: AG,
      sessionId: SESSION,
    });
  }
  writeSessionMessage(AG, SESSION, {
    id: messageId,
    kind: 'chat',
    timestamp: now(),
    platformId: 'slack:C1',
    channelType: 'slack',
    threadId: null,
    content: JSON.stringify(content),
  });
  const db = openOutboundDbRw(AG, SESSION);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
    ).run(messageId);
  } finally {
    db.close();
  }
}

/** 遅延 import: DB 初期化後にモジュールを掴む。resource は呼び出し側が必ず明示する。 */
function decide(resource: string | undefined, commandArgs: Record<string, unknown> = { role: 'admin', group: AG }) {
  return import('./permission-gate.js').then(({ decideAgentRequest }) =>
    decideAgentRequest({ agentGroupId: AG, sessionId: SESSION, resource, args: commandArgs }),
  );
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: AG, name: 'Lab', folder: 'lab', agent_provider: null, created_at: now() });
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
  upsertUser({ id: 'slack:MEMBER', kind: 'slack', display_name: 'Member', created_at: now() });
  grantRole({
    user_id: 'slack:ADMIN',
    role: 'admin',
    agent_group_id: AG,
    granted_by: null,
    granted_at: now(),
  });
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

describe('権限操作を即時実行してよいかの判断', () => {
  describe('権限分離を入れていない組織', () => {
    it('管理者の依頼でも、従来どおり承認カードに回すこと', async () => {
      await seedTurnFrom('slack:ADMIN');

      expect(await decide('roles')).toEqual({ action: 'defer' });
    });
  });

  describe('権限分離を入れた組織', () => {
    beforeEach(async () => {
      const { enablePermissionSplit } = await import('./permission-split.js');
      enablePermissionSplit(AG);
    });

    it('管理者本人の依頼なら、承認を待たずに実行してよいと判断すること', async () => {
      await seedTurnFrom('slack:ADMIN');

      expect(await decide('roles')).toEqual({
        action: 'allow',
        userId: 'slack:ADMIN',
        argOverrides: { granted_by: 'slack:ADMIN' },
      });
    });

    it('管理者でない人の依頼は断ること', async () => {
      await seedTurnFrom('slack:MEMBER');

      expect(await decide('roles')).toEqual({
        action: 'deny',
        message: 'この操作は管理者のみ実行できます。',
      });
    });

    it('依頼者を特定できないときは、即時実行はせず従来の承認カードに回すこと', async () => {
      await seedTurnFrom(null);

      expect(await decide('roles')).toEqual({ action: 'defer' });
    });

    it('複数人の発言が混ざっているときも、承認カードに回して人が判断できるようにすること', async () => {
      await seedTurnFrom('slack:ADMIN', 'm1');
      await seedTurnFrom('slack:MEMBER', 'm2');

      expect(await decide('roles')).toEqual({ action: 'defer' });
    });

    it('管理者以外の権限は、管理者の依頼であってもチャットからは付与させないこと', async () => {
      await seedTurnFrom('slack:ADMIN');

      const result = await decide('roles', { role: 'owner', group: AG });
      expect(result.action).toEqual('deny');
      expect(result).toHaveProperty('message', expect.stringContaining('管理者権限だけ'));
    });

    it('他のチャンネルの権限は、管理者の依頼であってもチャットからは変更させないこと', async () => {
      await seedTurnFrom('slack:ADMIN');

      const result = await decide('roles', { role: 'admin', group: 'ag-somewhere-else' });
      expect(result.action).toEqual('deny');
      expect(result).toHaveProperty('message', expect.stringContaining('このチャンネル以外'));
    });

    it('自分のチャンネルを明示した依頼は、そのまま通ること', async () => {
      await seedTurnFrom('slack:ADMIN');

      expect(await decide('roles', { role: 'admin', group: AG })).toEqual({
        action: 'allow',
        userId: 'slack:ADMIN',
        argOverrides: { granted_by: 'slack:ADMIN' },
      });
    });

    it('宛て先のチャンネルを省いた依頼は、全体への権限付与になりうるので断ること', async () => {
      await seedTurnFrom('slack:ADMIN');

      const result = await decide('roles', { role: 'admin' });
      expect(result.action).toEqual('deny');
      expect(result).toHaveProperty('message', expect.stringContaining('このチャンネル以外'));
    });

    it('メンバー追加でも、他のチャンネル宛ては断ること', async () => {
      await seedTurnFrom('slack:ADMIN');

      const result = await decide('members', { group: 'ag-somewhere-else' });
      expect(result.action).toEqual('deny');
      expect(result).toHaveProperty('message', expect.stringContaining('このチャンネル以外'));
    });

    it('権限に関わらないコマンドは、管理者の依頼でも従来どおり承認カードに回すこと', async () => {
      await seedTurnFrom('slack:ADMIN');

      expect(await decide('wirings')).toEqual({ action: 'defer' });
    });

    it('resource を持たないコマンドも、従来どおり承認カードに回すこと', async () => {
      await seedTurnFrom('slack:ADMIN');

      expect(await decide(undefined)).toEqual({ action: 'defer' });
    });

    it('メンバー追加も同じ扱いで、管理者本人なら実行してよいと判断すること', async () => {
      await seedTurnFrom('slack:ADMIN');

      expect(await decide('members', { group: AG })).toEqual({
        action: 'allow',
        userId: 'slack:ADMIN',
        argOverrides: { added_by: 'slack:ADMIN' },
      });
    });
  });
});
