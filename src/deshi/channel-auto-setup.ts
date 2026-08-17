/**
 * チャンネル登録の承認が完了した直後に、権限分離に必要な配線を続けて行う
 * (.deshi/adr/0019-bot-permission-split.md §5.2)。
 *
 * セットアップ専用の合言葉は用意しない。**承認カードを押せるのは owner/admin だけ**
 * なので、承認の完了そのものが「特権admin の意思表示」になっている。招待 → メンション
 * → 承認 → 返事、という既存の導線にそのまま乗る。
 *
 * `permission_split_config` の行が無い host では**何もしない**。既存環境の挙動は
 * 1 ミリも変わらない (ADR-0019 §0)。
 *
 * 途中の失敗でセットアップ全体を止めない。チャンネルは既に配線済みで、ここで throw
 * しても巻き戻せないため。できたところまでを完了投稿で正直に伝える。
 */
import { getMessagingGroup } from '../db/messaging-groups.js';
import { getDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { enablePermissionSplit, getPermissionSplitConfig } from './permission-split.js';
import { fetchChannelCreator, inviteToChannel } from './slack-workspace-api.js';

/**
 * 承認直後に呼ぶ。権限分離運用の host でなければ即 return。
 *
 * @param agentGroupId  このチャンネルに配線された agent group
 * @param messagingGroupId  対象チャンネル
 * @param approverUserId  承認カードを押した人 (= 特権admin)
 */
export async function runChannelAutoSetup(
  agentGroupId: string,
  messagingGroupId: string,
  approverUserId: string,
): Promise<void> {
  const config = getPermissionSplitConfig();
  if (!config) return;

  const mg = getMessagingGroup(messagingGroupId);
  if (!mg) return;
  // DM は権限分離の対象外。知識検索はチャンネルでのみ受け付ける (ADR-0019 §2)。
  if (mg.is_group === 0) return;
  // 知識検索BOT 自身の agent group を再セットアップしない。
  if (agentGroupId === config.knowledge_agent_group_id) return;

  enablePermissionSplit(agentGroupId);
  grantScopedAdmin(approverUserId, agentGroupId, approverUserId);

  const channelId = stripChannelPrefix(mg.platform_id);
  const channelManager = await resolveChannelManager(channelId);
  if (channelManager && channelManager !== approverUserId) {
    grantScopedAdmin(channelManager, agentGroupId, approverUserId);
  }

  const invited = config.knowledge_bot_user_id ? await inviteToChannel(channelId, config.knowledge_bot_user_id) : false;

  log.info('Channel auto-setup finished', {
    messagingGroupId,
    agentGroupId,
    approverUserId,
    channelManager,
    knowledgeBotInvited: invited,
  });

  await announce(mg.channel_type, mg.platform_id, {
    approverUserId,
    channelManager,
    knowledgeBotInvited: invited,
  });
}

/** scoped admin を付ける。既に有れば何も起きない (INSERT OR IGNORE)。 */
function grantScopedAdmin(userId: string, agentGroupId: string, grantedBy: string): void {
  grantRole({
    user_id: userId,
    role: 'admin',
    agent_group_id: agentGroupId,
    granted_by: grantedBy,
    granted_at: new Date().toISOString(),
  });
}

/**
 * チャンネル管理者を namespaced user id で返す。取れなければ `null`。
 *
 * Slack の「チャンネル管理者」ロールは公開 API から引けないため creator を候補にする。
 * どちらも取れない場合は特権admin だけが admin になり、あとはチャット経由で
 * 追加してもらう (ADR-0019 §5.2)。
 */
async function resolveChannelManager(channelId: string): Promise<string | null> {
  const creator = await fetchChannelCreator(channelId);
  return creator ? `slack:${creator}` : null;
}

/**
 * `slack:C0123` → `C0123`。messaging_groups.platform_id は channel 修飾済みだが、
 * Slack API に渡すのは素のチャンネル ID。
 */
function stripChannelPrefix(platformId: string): string {
  const idx = platformId.indexOf(':');
  return idx < 0 ? platformId : platformId.slice(idx + 1);
}

/** セットアップの結果をチャンネルに投稿する。何が済んで何が残っているかを書く。 */
async function announce(
  channelType: string,
  platformId: string,
  result: { approverUserId: string; channelManager: string | null; knowledgeBotInvited: boolean },
): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;

  const lines = ['このチャンネルのセットアップが完了しました。'];

  const admins = [result.approverUserId, result.channelManager].filter((v): v is string => v !== null);
  lines.push(`管理者: ${admins.map(mention).join(' ')}`);

  lines.push(
    result.knowledgeBotInvited
      ? '知識検索BOT をこのチャンネルに招待しました。'
      : '知識検索BOT はこのチャンネルに招待してください。',
  );
  lines.push('公開する知識の範囲は、DM に届くリンクから設定してください（設定するまでは何も答えられません）。');
  lines.push('管理者を追加するには、このチャンネルで「@対象者 に権限を付与して」と伝えてください。');

  try {
    await adapter.deliver(channelType, platformId, null, 'chat-sdk', JSON.stringify({ text: lines.join('\n') }));
    // eslint-disable-next-line no-catch-all/no-catch-all -- 投稿できなくても配線は済んでいる
  } catch (err) {
    log.warn('Channel auto-setup announcement failed', { platformId, err });
  }
}

/** `slack:U0123` → `<@U0123>`。Slack でメンションとして表示される形に戻す。 */
function mention(userId: string): string {
  return `<@${stripChannelPrefix(userId)}>`;
}
