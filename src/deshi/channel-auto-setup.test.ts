import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup } from '../db/messaging-groups.js';
import { upsertUser } from '../modules/permissions/db/users.js';

const deliver = vi.fn().mockResolvedValue('msg-id');
vi.mock('../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver }),
}));

const fetchChannelCreator = vi.fn().mockResolvedValue(null);
const inviteToChannel = vi.fn().mockResolvedValue(false);
vi.mock('./slack-workspace-api.js', () => ({
  fetchChannelCreator: (...args: unknown[]) => fetchChannelCreator(...args),
  inviteToChannel: (...args: unknown[]) => inviteToChannel(...args),
}));

const CHANNEL_AG = 'ag-lab';
const KNOWLEDGE_AG = 'ag-knowledge';
const APPROVER = 'slack:ADMIN';
const KNOWLEDGE_INSTANCE = 'slack-knowledge';

function now() {
  return new Date().toISOString();
}

function createChannel(id: string, platformId: string, isGroup = 1) {
  createMessagingGroup({
    id,
    channel_type: 'slack',
    platform_id: platformId,
    name: 'lab',
    is_group: isGroup,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

/** この host を権限分離運用にする。 */
async function enableHost(botUserId: string | null = 'UKNOWBOT') {
  const { setPermissionSplitConfig } = await import('./permission-split.js');
  setPermissionSplitConfig({
    knowledgeAgentGroupId: KNOWLEDGE_AG,
    knowledgeInstance: KNOWLEDGE_INSTANCE,
    knowledgeBotUserId: botUserId,
  });
}

async function run(agentGroupId = CHANNEL_AG, messagingGroupId = 'mg-1') {
  const { runChannelAutoSetup } = await import('./channel-auto-setup.js');
  return runChannelAutoSetup(agentGroupId, messagingGroupId, APPROVER);
}

async function adminGroupsOf(userId: string) {
  const { getDb } = await import('../db/connection.js');
  return (
    getDb().prepare("SELECT agent_group_id FROM user_roles WHERE user_id = ? AND role = 'admin'").all(userId) as Array<{
      agent_group_id: string | null;
    }>
  ).map((r) => r.agent_group_id);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchChannelCreator.mockResolvedValue(null);
  inviteToChannel.mockResolvedValue(false);
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: CHANNEL_AG, name: 'Lab', folder: 'lab', agent_provider: null, created_at: now() });
  createAgentGroup({ id: KNOWLEDGE_AG, name: 'Know', folder: 'know', agent_provider: null, created_at: now() });
  createChannel('mg-1', 'slack:C1');
  upsertUser({ id: APPROVER, kind: 'slack', display_name: 'Admin', created_at: now() });
});

afterEach(() => {
  closeDb();
});

describe('チャンネル登録の承認に続けて行うセットアップ', () => {
  describe('権限分離を導入していない host', () => {
    it('何も足さず、チャンネルにも投稿しないこと', async () => {
      await run();

      const { isPermissionSplitGroup } = await import('./permission-split.js');
      expect(isPermissionSplitGroup(CHANNEL_AG)).toEqual(false);
      expect(await adminGroupsOf(APPROVER)).toEqual([]);
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  describe('権限分離を導入した host', () => {
    beforeEach(async () => {
      await enableHost();
    });

    it('そのチャンネルを権限分離モードにすること', async () => {
      await run();

      const { isPermissionSplitGroup } = await import('./permission-split.js');
      expect(isPermissionSplitGroup(CHANNEL_AG)).toEqual(true);
    });

    it('承認した人が、そのチャンネルの管理者になること', async () => {
      await run();

      expect(await adminGroupsOf(APPROVER)).toEqual([CHANNEL_AG]);
    });

    it('チャンネルを作った人も管理者になること', async () => {
      fetchChannelCreator.mockResolvedValue('CREATOR');

      await run();

      expect(await adminGroupsOf('slack:CREATOR')).toEqual([CHANNEL_AG]);
    });

    it('チャンネルを作った人が分からなくても、承認した人だけで進むこと', async () => {
      fetchChannelCreator.mockResolvedValue(null);

      await run();

      expect(await adminGroupsOf(APPROVER)).toEqual([CHANNEL_AG]);
      expect(deliver).toHaveBeenCalled();
    });

    it('bot と話したことがないチャンネル作成者でも、管理者にできること', async () => {
      fetchChannelCreator.mockResolvedValue('NEWCOMER');

      await run();

      expect(await adminGroupsOf('slack:NEWCOMER')).toEqual([CHANNEL_AG]);
    });

    it('同じチャンネルで承認が二度走っても壊れないこと', async () => {
      fetchChannelCreator.mockResolvedValue('CREATOR');

      await run();
      await run();

      expect(await adminGroupsOf(APPROVER)).toEqual([CHANNEL_AG]);
      expect(await adminGroupsOf('slack:CREATOR')).toEqual([CHANNEL_AG]);
    });

    it('チャンネルを作った人が承認者本人なら、二重に登録しないこと', async () => {
      fetchChannelCreator.mockResolvedValue('ADMIN');

      await run();

      expect(await adminGroupsOf(APPROVER)).toEqual([CHANNEL_AG]);
    });

    it('セットアップ中に失敗しても、承認フローを巻き込まないこと', async () => {
      fetchChannelCreator.mockRejectedValue(new Error('slack down'));

      await expect(run()).resolves.toBeUndefined();
    });

    it('知識検索BOT をそのチャンネルに招待すること', async () => {
      await run();

      expect(inviteToChannel).toHaveBeenCalledWith('C1', 'UKNOWBOT');
    });

    it('招待できたときは、その旨をチャンネルに伝えること', async () => {
      inviteToChannel.mockResolvedValue(true);

      await run();

      const text = JSON.parse(deliver.mock.calls[0][4]).text as string;
      expect(text).toContain('招待しました');
    });

    it('招待できなかったときは、招待を依頼する文をチャンネルに出すこと', async () => {
      inviteToChannel.mockResolvedValue(false);

      await run();

      const text = JSON.parse(deliver.mock.calls[0][4]).text as string;
      expect(text).toContain('招待してください');
    });

    it('完了の知らせを、DM ではなくそのチャンネルに投稿すること', async () => {
      await run();

      const [channelType, platformId] = deliver.mock.calls[0];
      expect(channelType).toEqual('slack');
      expect(platformId).toEqual('slack:C1');
    });

    it('管理者を Slack のメンション表記で伝えること', async () => {
      await run();

      const text = JSON.parse(deliver.mock.calls[0][4]).text as string;
      expect(text).toContain('<@ADMIN>');
    });

    it('知識検索BOT 側のチャンネル登録を先回りで済ませること（承認が二度要らないように）', async () => {
      await run();

      const { getMessagingGroupByPlatform } = await import('../db/messaging-groups.js');
      const knowledgeChannel = getMessagingGroupByPlatform('slack', 'slack:C1', KNOWLEDGE_INSTANCE);
      expect(knowledgeChannel).toBeDefined();

      const { getDb } = await import('../db/connection.js');
      expect(
        getDb()
          .prepare('SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id = ?')
          .get(knowledgeChannel!.id),
      ).toEqual({ agent_group_id: KNOWLEDGE_AG });
    });

    it('知識検索BOT 側は、承認を待たずに誰でも質問できる設定にすること', async () => {
      await run();

      const { getMessagingGroupByPlatform } = await import('../db/messaging-groups.js');
      const knowledgeChannel = getMessagingGroupByPlatform('slack', 'slack:C1', KNOWLEDGE_INSTANCE);
      expect(knowledgeChannel?.unknown_sender_policy).toEqual('public');
    });

    it('管理者BOT 側の設定は、知識検索BOT の配線に引きずられないこと', async () => {
      await run();

      const { getMessagingGroupByPlatform } = await import('../db/messaging-groups.js');
      expect(getMessagingGroupByPlatform('slack', 'slack:C1', 'slack')?.unknown_sender_policy).toEqual('strict');
    });

    it('二度走らせても、知識検索BOT の配線が重複しないこと', async () => {
      await run();
      await run();

      const { getDb } = await import('../db/connection.js');
      const rows = getDb()
        .prepare('SELECT id FROM messaging_group_agents WHERE agent_group_id = ?')
        .all(KNOWLEDGE_AG) as unknown[];
      expect(rows.length).toEqual(1);
    });

    it('DM が登録されたときは、セットアップを走らせないこと', async () => {
      createChannel('mg-dm', 'slack:D1', 0);

      await run(CHANNEL_AG, 'mg-dm');

      const { isPermissionSplitGroup } = await import('./permission-split.js');
      expect(isPermissionSplitGroup(CHANNEL_AG)).toEqual(false);
      expect(deliver).not.toHaveBeenCalled();
    });

    it('知識検索BOT 自身のチャンネル配線では、セットアップを走らせないこと', async () => {
      await run(KNOWLEDGE_AG);

      const { isPermissionSplitGroup } = await import('./permission-split.js');
      expect(isPermissionSplitGroup(KNOWLEDGE_AG)).toEqual(false);
      expect(deliver).not.toHaveBeenCalled();
    });

    it('知識検索BOT の user id が分からない環境では、招待を試みないこと', async () => {
      const { getDb } = await import('../db/connection.js');
      getDb().prepare('DELETE FROM permission_split_config').run();
      await enableHost(null);

      await run();

      expect(inviteToChannel).not.toHaveBeenCalled();
    });

    it('あとから token 無しでやり直しても、覚えている user id を消さないこと', async () => {
      await enableHost(null);

      await run();

      expect(inviteToChannel).toHaveBeenCalledWith('C1', 'UKNOWBOT');
    });
  });
});
