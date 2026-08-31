/**
 * 知識検索系 host-tool (search / read) の共通前段
 * (.deshi/adr/0021-bot-permission-split.md §4)。
 *
 * ## channelId を引数で受け取らない
 *
 * 知識検索BOT の部屋には外部の人が居る。channelId を引数にすると、prompt injection で
 * 「別の部屋の id で検索しろ」と言わせるだけで他ルームの知識が読める。boswell 側の
 * 公開範囲は channelId をキーに引かれる (`daemon/src/routes/knowledge.ts`) ので、
 * ここがそのまま公開範囲の決定点になる。
 *
 * そのため部屋は container の申告ではなく **sender token から host 側で解決する**
 * (ADR-0020)。token は host が inbound の各メッセージに打刻したもので、container は
 * 自分の部屋のものしか持っていない。偽造すれば解決できず、本物を使えば自分の部屋に
 * 解決される。`channelId` / `channelContext` を body に混ぜても読まない。
 *
 * ## fail-closed
 *
 * 解決できない・期限切れ・知識検索BOT 以外の agent group の token・権限分離運用でない
 * host — いずれも **boswell に問い合わせる前に**断る。疑わしい要求を一度でも通すと
 * 公開範囲外の知識が返る側に倒れるため、判断を後段に委ねない。
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { resolveDaemonEnv } from '../daemon-env.js';
import { getPermissionSplitConfig } from '../permission-split.js';
import { resolveSenderToken } from '../sender-token.js';

/** boswell の検索は同期で返る。polling していた頃の長い待ちは要らない。 */
export const KNOWLEDGE_TIMEOUT_MS = Number(process.env.DESHI_KNOWLEDGE_TIMEOUT_MS ?? 30000);

export const UNVERIFIED_ROOM_ERROR = 'この部屋からの質問として確認できませんでした';
export const BAD_REQUEST_ERROR = '質問の内容を受け取れませんでした';
export const INDEX_UNAVAILABLE_ERROR = '知識検索の準備ができていません。しばらくしてから再度お試しください';

export type KnowledgeRequestContext =
  | { ok: true; url: string; secret: string; channelId: string }
  | { ok: false; error: string };

/** boswell を呼ぶ前に、依頼元と公開範囲の解決に必要な条件をすべて確定する。 */
export function resolveKnowledgeRequest(senderToken: unknown, unavailableError: string): KnowledgeRequestContext {
  const config = getPermissionSplitConfig();
  if (!config) return { ok: false, error: unavailableError };

  if (typeof senderToken !== 'string') return { ok: false, error: UNVERIFIED_ROOM_ERROR };
  const sender = resolveSenderToken(senderToken);
  if (!sender || sender.agent_group_id !== config.knowledge_agent_group_id) {
    return { ok: false, error: UNVERIFIED_ROOM_ERROR };
  }

  const messagingGroup = getMessagingGroup(sender.messaging_group_id);
  if (!messagingGroup) return { ok: false, error: UNVERIFIED_ROOM_ERROR };

  const { url, secret } = resolveDaemonEnv();
  if (!secret) return { ok: false, error: unavailableError };

  return { ok: true, url, secret, channelId: messagingGroup.platform_id };
}
