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
 * ## 何があっても承認フローを止めない
 *
 * 本関数は承認 handler の途中から呼ばれ、この後に元メッセージの replay と知識スコープ
 * リンクの配送が控えている。ここで throw すると**チャンネルは配線済みなのに replay も
 * リンク配送も飛ぶ**という中途半端な状態になり、しかもカードは成功表示のまま残る。
 * そのため全体を try/catch で包み、できたところまでで進む。
 */
import { getDb } from '../db/connection.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { getDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import type { MessagingGroup } from '../types.js';
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
  try {
    await setUpChannel(agentGroupId, messagingGroupId, approverUserId);
    // eslint-disable-next-line no-catch-all/no-catch-all -- 承認フローを止めないことが最優先
  } catch (err) {
    log.error('Channel auto-setup failed — channel stays wired without permission split', {
      messagingGroupId,
      agentGroupId,
      err,
    });
  }
}

async function setUpChannel(agentGroupId: string, messagingGroupId: string, approverUserId: string): Promise<void> {
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

  const channelId = stripNamespace(mg.platform_id);
  const workspaceReachable = isPrimaryInstance(mg);

  const channelManager = workspaceReachable ? await resolveChannelManager(channelId, approverUserId) : null;
  if (channelManager) {
    grantScopedAdmin(channelManager, agentGroupId, approverUserId);
  }

  const invited =
    workspaceReachable && config.knowledge_bot_user_id
      ? await inviteToChannel(channelId, config.knowledge_bot_user_id)
      : false;

  log.info('Channel auto-setup finished', {
    messagingGroupId,
    agentGroupId,
    approverUserId,
    channelManager,
    knowledgeBotInvited: invited,
    workspaceReachable,
  });

  await announce(mg, { approverUserId, channelManager, knowledgeBotInvited: invited });
}

/**
 * scoped admin を付ける。
 *
 * `grantRole` を使わないのは、あちらが素の INSERT で、同じ人が同じ agent group で
 * 2 度目の承認をすると PRIMARY KEY 違反で throw するため。ここは**同じ相手に二度
 * 走っても壊れない**必要があるので `INSERT OR IGNORE` を使う (`ncl roles grant` と同じ)。
 *
 * `users` 行が無ければ先に作る。チャンネル作成者は bot と会話したことが無いのが普通で、
 * `user_roles.user_id` の FK に引っかかる。
 */
function grantScopedAdmin(userId: string, agentGroupId: string, grantedBy: string): void {
  upsertUser({
    id: userId,
    kind: namespaceOf(userId),
    display_name: null,
    created_at: new Date().toISOString(),
  });
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, 'admin', ?, ?, ?)`,
    )
    .run(userId, agentGroupId, grantedBy, new Date().toISOString());
}

/**
 * チャンネル管理者を namespaced user id で返す。取れなければ、または承認者と同じなら
 * `null`。
 *
 * Slack の「チャンネル管理者」ロールは公開 API から引けないため creator を候補にする。
 * どちらも取れない場合は特権admin だけが admin になり、あとはチャット経由で
 * 追加してもらう (ADR-0019 §5.2)。
 */
async function resolveChannelManager(channelId: string, approverUserId: string): Promise<string | null> {
  const creator = await fetchChannelCreator(channelId);
  if (!creator) return null;
  const userId = `slack:${creator}`;
  return userId === approverUserId ? null : userId;
}

/**
 * Slack Web API を叩ける相手か。
 *
 * 叩くのは primary instance (管理者BOT) の bot token 固定なので、named instance の
 * チャンネルには効かない。ADR-0019 §1 では管理者BOT が primary なので通常はここを
 * 通るが、多ワークスペース構成 (ADR-0018) で他 instance のチャンネルが来たときに
 * 誤った workspace を触らないよう明示的に外す。
 */
function isPrimaryInstance(mg: MessagingGroup): boolean {
  return mg.instance === mg.channel_type;
}

/** `slack:C0123` → `C0123`。Slack API に渡すのは素の ID。 */
function stripNamespace(id: string): string {
  const idx = id.indexOf(':');
  return idx < 0 ? id : id.slice(idx + 1);
}

/** `slack:U0123` → `slack`。 */
function namespaceOf(id: string): string {
  const idx = id.indexOf(':');
  return idx < 0 ? id : id.slice(0, idx);
}

/** セットアップの結果をチャンネルに投稿する。何が済んで何が残っているかを書く。 */
async function announce(
  mg: MessagingGroup,
  result: { approverUserId: string; channelManager: string | null; knowledgeBotInvited: boolean },
): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;

  const admins = [result.approverUserId, result.channelManager].filter((v): v is string => v !== null);
  const lines = [
    'このチャンネルのセットアップが完了しました。',
    `管理者: ${admins.map(mention).join(' ')}`,
    result.knowledgeBotInvited
      ? '知識検索BOT をこのチャンネルに招待しました。'
      : '知識検索BOT はこのチャンネルに招待してください。',
    '公開する知識の範囲は、DM に届くリンクから設定してください（設定するまでは何も答えられません）。',
    '管理者を追加するには、このチャンネルで「@対象者 に権限を付与して」と伝えてください。',
  ];

  try {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text: lines.join('\n') }),
      undefined,
      mg.instance,
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- 投稿できなくても配線は済んでいる
  } catch (err) {
    log.warn('Channel auto-setup announcement failed', { platformId: mg.platform_id, err });
  }
}

/** `slack:U0123` → `<@U0123>`。Slack でメンションとして表示される形に戻す。 */
function mention(userId: string): string {
  return `<@${stripNamespace(userId)}>`;
}
