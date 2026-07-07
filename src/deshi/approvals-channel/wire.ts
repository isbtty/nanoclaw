/**
 * deshi#517 — 承認/許可通知を owner/admin 個人 DM ではなく共有チャンネルに集約する
 * 「案D: `user_dms` リダイレクト」の配線ヘルパ。**コア非改修**。
 *
 * ## 仕組み（なぜ動くか）
 *
 * host が承認カード/招待/知識スコープ編集リンクを送るとき、宛先は必ず
 * `ensureUserDm(approver)`（`src/modules/permissions/user-dm.ts`）で解決される。
 * `ensureUserDm` は `user_dms` キャッシュにヒットすると `is_group` を検証せず
 * その messaging_group をそのまま返す。よって owner/admin の `user_dms` 行を
 * **共有チャンネルの messaging_group** に向けておけば、カードは個人 DM ではなく
 * その共有チャンネルに投稿される。
 *
 * 承認ボタンは `clickerId === approver_user_id || hasAdminPrivilege(...)`
 * （`src/modules/permissions/index.ts:239,320`）で認可されるため、宛先が特定 1 人でも
 * チャンネルにいる owner/admin なら誰が押しても承認が通る。
 *
 * ## スコープ
 *
 * deshi#517 は Slack 単一導入が前提。よって channel_type は既定で `'slack'` とし、
 * `slack:` identity を持つ owner/admin のみをリダイレクトする。他 channel_type の
 * approver は対象外（元の DM 解決のまま）。
 *
 * ## 影響範囲（重要）
 *
 * `user_dms` を経由するのは承認/招待/知識リンクの host 起点通知だけ。ユーザー起点の
 * 普通の DM 会話は `user_dms` を通らないため一切影響を受けない。
 *
 * 実機での実行は setup skill `/deshi-route-approvals-to-channel` 経由（別 Mac mini 上）。
 */
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  setMessagingGroupDeniedAt,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';
import { upsertUserDm } from '../../modules/permissions/db/user-dms.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../../modules/permissions/db/user-roles.js';

export interface WireOptions {
  /** 共有チャンネルの platform_id（Slack channel ID `Cxxxx`）。 */
  platformId: string;
  /** channel_type。deshi#517 は Slack 単一なので既定 `'slack'`。 */
  channelType?: string;
  /** 共有チャンネル mg を新規作成する場合の表示名。 */
  name?: string;
  /**
   * 追加でリダイレクト対象にする scoped admin の agent_group_id 群。
   * 省略時は owner + global admin のみ。
   */
  scopedAgentGroupIds?: string[];
}

export interface WireResult {
  messagingGroupId: string;
  /** mg を今回新規作成したか（既存を再利用したなら false）。 */
  created: boolean;
  /** 共有チャンネルに向けた user_id 群。 */
  redirected: string[];
  /**
   * owner/admin だが対象 channel_type の identity ではないため据え置いた user_id 群。
   * （例: Slack 単一運用で `telegram:` の owner）
   */
  skipped: string[];
}

// user_id の `:` 前プレフィックスを channel_type とみなす。deshi#517 は Slack 単一
// （`slack:Uxxx`）前提なのでこれで正しい。将来 Teams 等（id が `29:` 始まりで
// channel_type が user.kind 由来）に転用するなら user-dm.ts:parseUserId 同様の
// kind フォールバックが要る点に注意。
function channelTypeOf(userId: string): string | null {
  const idx = userId.indexOf(':');
  return idx > 0 ? userId.slice(0, idx) : null;
}

/**
 * 共有チャンネルの mg を find-or-create し、対象 channel_type の identity を持つ
 * owner/admin の `user_dms` をそこへ upsert する。冪等（再実行で同じ mg に upsert
 * されるだけ）。DB は呼び出し前に `initDb()` 済みであること。
 */
export function routeApprovalsToChannel(opts: WireOptions): WireResult {
  const channelType = opts.channelType ?? 'slack';
  const now = new Date().toISOString();

  // 1) 共有チャンネルの messaging_group を find-or-create。
  //    getMessagingGroupByPlatform は find-only なので、無ければ自前で作る。
  //
  //    配信先専用にするため、作成時に denied_at を立てる。router の channel
  //    登録 escalation は `agentCount===0 && isMention` で発火し
  //    unknown_sender_policy は参照しない（`src/router.ts:229-237`）。唯一
  //    `mg.denied_at` が立っていれば escalation を握って drop する。よって
  //    owner/admin がこのチャンネルで bot を @mention しても「登録するか？」
  //    カードが同チャンネルに出るループを防ぐには denied_at が必須。
  //    is_group=1 はグループ扱い、unknown_sender_policy='strict' は既定として付与
  //    （escalation 抑止には効かないが害も無い）。
  //    denied_at は delivery 経路では参照されない（承認カードの配信は妨げない）。
  //
  //    既存 mg を再利用する場合は属性を一切変更しない（他用途のチャンネルを
  //    誤指定しても壊さない。skill は専用チャンネルの新規作成を案内する）。
  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(channelType, opts.platformId);
  let created = false;
  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: channelType,
      platform_id: opts.platformId,
      name: opts.name ?? null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    };
    createMessagingGroup(mg);
    setMessagingGroupDeniedAt(mgId, now);
    created = true;
    log.info('routeApprovalsToChannel: created shared messaging_group', {
      channelType,
      platformId: opts.platformId,
      messagingGroupId: mgId,
    });
  }

  // 2) 対象 user_id を集約（owner + global admin + 任意で scoped admin）。順序無視・重複排除。
  const targets = new Set<string>();
  for (const r of getOwners()) targets.add(r.user_id);
  for (const r of getGlobalAdmins()) targets.add(r.user_id);
  for (const gid of opts.scopedAgentGroupIds ?? []) {
    for (const r of getAdminsOfAgentGroup(gid)) targets.add(r.user_id);
  }

  // 3) 対象 channel_type の identity を持つ user だけ共有チャンネルへ向ける。
  const redirected: string[] = [];
  const skipped: string[] = [];
  for (const userId of targets) {
    if (channelTypeOf(userId) !== channelType) {
      skipped.push(userId);
      continue;
    }
    upsertUserDm({
      user_id: userId,
      channel_type: channelType,
      messaging_group_id: mg.id,
      resolved_at: now,
    });
    redirected.push(userId);
  }

  log.info('routeApprovalsToChannel: redirected approvers to shared channel', {
    channelType,
    messagingGroupId: mg.id,
    redirected: redirected.length,
    skipped: skipped.length,
  });

  return { messagingGroupId: mg.id, created, redirected, skipped };
}
