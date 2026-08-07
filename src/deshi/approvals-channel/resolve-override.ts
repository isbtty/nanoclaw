/**
 * boswell#712 — owner/admin 宛の host 起点 DM を共有承認チャンネルへ振り替える。
 *
 * ## なぜ「配線時の書き換え」ではなく「配信時の判定」なのか
 *
 * 旧方式（deshi#517）は配線実行時点の owner/admin の `user_dms` 行を共有チャンネルに
 * 書き換えるスナップショットだった。以降に admin を付与しても適用されず、その人が
 * 先頭 approver になった時点で承認カードが個人 DM に出て埋もれる（boswell#712 の事故）。
 *
 * 本モジュールは宛先解決の瞬間に `user_roles` を引き直す。admin を後から付与すれば
 * 自動的に効き、revoke すれば自動的に通常の DM 解決へ戻る。
 *
 * ## 適用範囲
 *
 * `ensureUserDm` は host 起点通知の唯一の choke point なので、承認カードだけでなく
 * 知識スコープ編集リンク・チャンネル登録の完了通知・reject 理由プロンプトも共有
 * チャンネルに出る。いずれも「確定した approver 1 名宛」である点は変わらない
 * （配信先が 1 か所に増減するわけではない）。
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { getUserRoles } from '../../modules/permissions/db/user-roles.js';
import type { MessagingGroup } from '../../types.js';
import { getApprovalsChannel } from './db.js';

/**
 * 共有承認チャンネルの messaging_group を返す。以下はすべて `null` を返し、
 * upstream の通常 DM 解決にフォールバックする:
 *   - 配線されていない（= 既定インストールでは常に no-op）
 *   - 対象 user が今 owner でも admin でもない
 *   - 配線先の messaging_group が削除済み
 *
 * `channelType` は呼び出し側（`ensureUserDm`）が `parseUserId` で解決済みのものを
 * 渡す。Teams のように id が `29:` 始まりで channel_type が `user.kind` 由来の
 * ケースをここで再実装しないため。
 */
export function resolveApprovalsChannelOverride(userId: string, channelType: string): MessagingGroup | null {
  const wiring = getApprovalsChannel(channelType);
  if (!wiring) return null;

  // owner / global admin / scoped admin のいずれか。user_roles の role は
  // owner|admin の 2 種のみなので、行が 1 つでもあれば対象。
  if (getUserRoles(userId).length === 0) return null;

  const mg = getMessagingGroup(wiring.messaging_group_id);
  if (!mg) {
    log.warn('approvals-channel: wired messaging_group is missing, falling back to personal DM', {
      userId,
      channelType,
      messagingGroupId: wiring.messaging_group_id,
    });
    return null;
  }

  return mg;
}
