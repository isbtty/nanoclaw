/**
 * ゲートの判断が dispatch の実挙動に反映されているかの結合テスト。
 *
 * permission-gate.test.ts は判断そのものを見る。ここは「allow なら handler が
 * 走る / deny なら forbidden / defer なら承認カード」の配線を見る。
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup } from '../db/messaging-groups.js';
import { createSession } from '../db/sessions.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import type { CallerContext } from '../cli/frame.js';
// 実物の roles リソースを登録する。スタブ handler だと「handler が宛て先として
// 読むのは --group だけ」という契約が走らず、ゲートの穴を検出できない。
import '../cli/resources/roles.js';

const requestApproval = vi.fn();
vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: (...args: unknown[]) => requestApproval(...args),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-gate-dispatch' };
});

const TEST_DIR = '/tmp/nanoclaw-test-gate-dispatch';
const AG = 'ag-lab';
const SESSION = 'sess-1';

function now() {
  return new Date().toISOString();
}

/** この agent group を cli_scope='global' にする (auto-fill が走らなくなる)。 */
async function useGlobalCliScope() {
  const { getDb } = await import('../db/connection.js');
  getDb()
    .prepare(
      "INSERT INTO container_configs (agent_group_id, cli_scope, updated_at) VALUES (?, 'global', datetime('now'))",
    )
    .run(AG);
}

function agentCtx(): CallerContext {
  return { caller: 'agent', sessionId: SESSION, agentGroupId: AG, messagingGroupId: 'mg-1' };
}

async function seedTurnFrom(userId: string) {
  const { writeSessionMessage, openOutboundDbRw } = await import('../session-manager.js');
  const { issueSenderToken } = await import('./sender-token.js');
  const token = issueSenderToken({
    userId,
    messagingGroupId: 'mg-1',
    agentGroupId: AG,
    sessionId: SESSION,
  });
  writeSessionMessage(AG, SESSION, {
    id: 'm1',
    kind: 'chat',
    timestamp: now(),
    platformId: 'slack:C1',
    channelType: 'slack',
    threadId: null,
    content: JSON.stringify({ text: '権限つけて', senderToken: token }),
  });
  const db = openOutboundDbRw(AG, SESSION);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
    ).run('m1');
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
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
  grantRole({ user_id: 'slack:ADMIN', role: 'admin', agent_group_id: AG, granted_by: null, granted_at: now() });
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

async function run(args: Record<string, unknown> = { role: 'admin', user: 'slack:MEMBER', group: AG }) {
  const { dispatch } = await import('../cli/dispatch.js');
  return dispatch({ id: 'req-1', command: 'roles-grant', args }, agentCtx());
}

/** slack:MEMBER に実際に付いた role 行 (無ければ undefined)。 */
async function grantedRole() {
  const { getDb } = await import('../db/connection.js');
  return getDb()
    .prepare("SELECT role, agent_group_id, granted_by FROM user_roles WHERE user_id = 'slack:MEMBER'")
    .get() as { role: string; agent_group_id: string | null; granted_by: string | null } | undefined;
}

describe('権限操作の実行可否が dispatch に反映されること', () => {
  it('権限分離を入れていない組織では、権限コマンドはそもそも届かないこと', async () => {
    await seedTurnFrom('slack:ADMIN');

    const resp = await run();

    expect(resp.ok).toEqual(false);
    expect(await grantedRole()).toBeUndefined();
  });

  describe('権限分離を入れた組織', () => {
    beforeEach(async () => {
      const { enablePermissionSplit } = await import('./permission-split.js');
      enablePermissionSplit(AG);
    });

    it('管理者本人の依頼なら、承認を待たずに実行されること', async () => {
      await seedTurnFrom('slack:ADMIN');

      const resp = await run();

      expect(resp.ok).toEqual(true);
      // 宛て先がこのチャンネルに閉じていること (global 権限になっていないこと)
      expect(await grantedRole()).toEqual({ role: 'admin', agent_group_id: AG, granted_by: 'slack:ADMIN' });
      expect(requestApproval).not.toHaveBeenCalled();
    });

    it('管理者でない人の依頼は実行されず、理由が返ること', async () => {
      await seedTurnFrom('slack:MEMBER');

      const resp = await run();

      expect(resp.ok).toEqual(false);
      if (!resp.ok) expect(resp.error.message).toContain('管理者のみ');
      expect(await grantedRole()).toBeUndefined();
      expect(requestApproval).not.toHaveBeenCalled();
    });

    it('依頼者を特定できないときは実行されず、承認カードに回ること', async () => {
      const resp = await run();

      expect(resp.ok).toEqual(false);
      expect(await grantedRole()).toBeUndefined();
      expect(requestApproval).toHaveBeenCalled();
    });

    it('agent が依頼者を偽っても、host が確定した依頼者で記録されること', async () => {
      await seedTurnFrom('slack:ADMIN');

      await run({ role: 'admin', user: 'slack:MEMBER', group: AG, 'granted-by': 'slack:MEMBER' });

      expect(await grantedRole()).toEqual(expect.objectContaining({ granted_by: 'slack:ADMIN' }));
    });

    it('宛て先を別名の引数で渡しても、チャンネル外の権限は触らせないこと', async () => {
      await useGlobalCliScope();
      await seedTurnFrom('slack:ADMIN');

      const resp = await run({ role: 'admin', user: 'slack:MEMBER', agent_group_id: AG });

      expect(resp.ok).toEqual(false);
      expect(await grantedRole()).toBeUndefined();
    });

    it('承認カードを通した実行でも、チャンネル外の権限は触らせないこと', async () => {
      // cli_scope='global' では dispatch の auto-fill が走らないため、--group を
      // 省いた依頼が「全体への権限付与」として届きうる。承認を挟んでも塞ぐ。
      await useGlobalCliScope();
      const { dispatch } = await import('../cli/dispatch.js');

      const resp = await dispatch(
        { id: 'req-1', command: 'roles-grant', args: { role: 'admin', user: 'slack:MEMBER' } },
        agentCtx(),
        { approved: true },
      );

      expect(resp.ok).toEqual(false);
      if (!resp.ok) expect(resp.error.message).toContain('このチャンネル以外');
      expect(await grantedRole()).toBeUndefined();
    });

    it('承認カードを通した実行は、カードを出し直さずそのまま実行されること', async () => {
      const { dispatch } = await import('../cli/dispatch.js');

      const resp = await dispatch(
        { id: 'req-1', command: 'roles-grant', args: { role: 'admin', user: 'slack:MEMBER', group: AG } },
        agentCtx(),
        { approved: true },
      );

      expect(resp.ok).toEqual(true);
      expect(await grantedRole()).toEqual(expect.objectContaining({ role: 'admin', agent_group_id: AG }));
      expect(requestApproval).not.toHaveBeenCalled();
    });

    it('管理者以外の権限を付けようとする依頼は、実行も承認依頼もされないこと', async () => {
      await seedTurnFrom('slack:ADMIN');

      const resp = await run({ role: 'owner', user: 'slack:MEMBER', group: AG });

      expect(resp.ok).toEqual(false);
      if (!resp.ok) expect(resp.error.message).toContain('管理者権限だけ');
      expect(await grantedRole()).toBeUndefined();
      expect(requestApproval).not.toHaveBeenCalled();
    });
  });
});
