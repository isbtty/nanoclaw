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
 * 実機での実行は setup skill `/boswell-route-approvals-to-channel` 経由（別 Mac mini 上）。
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
  /**
   * 共有チャンネルの ID。生 ID（`Cxxxx`）でも adapter エンコード済み
   * （`slack:Cxxxx`）でも渡せる。内部で `<channelType>:<id>` に正規化する。
   */
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
  /**
   * 同一チャンネルの、prefix 無し生 ID（`Cxxxx`）で作られた壊れた mg を検出した場合の
   * その id。deshi#528 の修正前に配線した環境の残骸。存在すれば呼び出し側（run.ts）が
   * 手動 cleanup を促す。無ければ undefined。
   */
  legacyMessagingGroupId?: string;
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
 * チャンネル ID を adapter エンコード形式（`<channelType>:<id>`）に正規化する。
 * router / delivery はこの形式で messaging_group を lookup / auto-create し、
 * delivery は `platform_id` をエンコード済み thread ID としてそのまま使う
 * （`src/router.ts:190-206`、`src/channels/chat-sdk-bridge.ts:570-573`）。
 * 生 ID のまま保存すると承認カードが配信されず、router が別 mg を auto-create して
 * `denied_at` も効かなくなる（deshi#528）。
 *
 * 生 ID（`Cxxxx`）でも既にエンコード済み（`slack:Cxxxx`）でも冪等に正しい形へ揃える。
 * Slack の生 ID には `:` を含まない前提。将来他チャンネルに広げる場合は
 * user-dm.ts / router の platformId エンコード規約に合わせること。
 */
function encodePlatformId(channelType: string, raw: string): string {
  return raw.startsWith(`${channelType}:`) ? raw : `${channelType}:${raw}`;
}

/**
 * 共有チャンネルの mg を find-or-create し、対象 channel_type の identity を持つ
 * owner/admin の `user_dms` をそこへ upsert する。冪等（再実行で同じ mg に upsert
 * されるだけ）。DB は呼び出し前に `initDb()` 済みであること。
 */
export function routeApprovalsToChannel(opts: WireOptions): WireResult {
  const channelType = opts.channelType ?? 'slack';
  const now = new Date().toISOString();

  // platform_id は必ず adapter エンコード形式（`<channelType>:<id>`）に揃える。
  // router / delivery がこの形式で lookup / 配信するため（deshi#528）。
  const platformId = encodePlatformId(channelType, opts.platformId);

  // deshi#528 修正前に prefix 無し生 ID で作られた壊れた mg の検出用（cleanup 促し）。
  // 正規化後の platformId から prefix を外した生 ID で引く。生 ID == 正規化後
  // （= 元から prefix 無し channel_type だった等）の場合は誤検出になるので除外。
  const rawId = platformId.slice(channelType.length + 1);
  const legacyMg = rawId !== platformId ? getMessagingGroupByPlatform(channelType, rawId) : undefined;

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
  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(channelType, platformId);
  let created = false;
  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: channelType,
      platform_id: platformId,
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
      platformId,
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

  // legacy（prefix 無し）mg が正規 mg とは別に残っていれば報告する。FK 参照
  // （pending_channel_approvals 等）があり得るので自動削除はせず、呼び出し側が
  // 手動 cleanup を判断する（deshi#528「実施済みの手動復旧」参照）。
  const legacyMessagingGroupId = legacyMg && legacyMg.id !== mg.id ? legacyMg.id : undefined;
  if (legacyMessagingGroupId) {
    log.warn('routeApprovalsToChannel: found leftover prefix-less messaging_group for this channel', {
      channelType,
      canonicalMessagingGroupId: mg.id,
      legacyMessagingGroupId,
    });
  }

  return { messagingGroupId: mg.id, created, redirected, skipped, legacyMessagingGroupId };
}
