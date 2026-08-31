/**
 * 「いま container が処理しているターンの依頼者は誰か」を host 側だけで決める
 * (.deshi/adr/0020-sender-token.md)。
 *
 * container からの CLI 要求は `CallerContext` に session が乗っており、これは
 * host が `session` オブジェクトから組み立てた値で container の申告値ではない
 * (`src/cli/delivery-action.ts`)。そこから:
 *
 *   1. outbound.db の `processing_ack` — container が「いま処理中」と印を付けた
 *      メッセージ id の集合 (= このターンの入力)
 *   2. inbound.db の `messages_in` — その content に host が刻んだ senderToken
 *
 * を突き合わせて発言者を引く。**LLM は経路に一切登場しない**ため、トークンを
 * プロンプトに載せる必要も、agent にトークンを引用させる必要もない。
 *
 * 判定はすべて fail-closed。ターンに含まれるユーザー発話のうち 1 つでも発言者を
 * 引けないものがあれば、残りが揃っていても依頼者は確定させない。1 人でも他人の
 * 発話が混ざれば断る。ユーザー発話以外 (system / CLI 応答など) は依頼者の判定に
 * 使わないので数えない。
 *
 * ## この仕組みが守らないもの
 *
 * container が prompt injection 等で乗っ取られた場合、そのセッションに届いた
 * 他人のメッセージを「処理中」と印を付けてなりすませる — inbound.db は container
 * から読めるため、トークンを足しても防げない。本モジュールが消すのは **事故に
 * よる取り違え** であり、TTL によって「何日も前の発言を後から使う」窓を閉じる。
 * 乗っ取られた container の隔離そのものは別の課題。
 */
import { openInboundDb, openOutboundDb } from '../db/session-db.js';
import { inboundDbPath, outboundDbPath } from '../session-manager.js';
import { log } from '../log.js';
import { resolveSenderToken, type SenderToken } from './sender-token.js';

export type TurnSender =
  | { ok: true; userId: string; token: SenderToken }
  | { ok: false; reason: 'no-user-message' | 'unresolved' | 'expired' | 'mixed-senders' };

/** 依頼者の判定に使うメッセージ種別。system / CLI 応答は依頼ではないので除く。 */
const USER_MESSAGE_KINDS = ['chat', 'chat-sdk'];

/**
 * このターンの依頼者を引く。呼び出し側は `ok: false` を「権限が要る操作は断る」
 * として扱う。
 */
export function resolveTurnSender(agentGroupId: string, sessionId: string, now: Date = new Date()): TurnSender {
  const contents = readProcessingUserMessages(agentGroupId, sessionId);
  if (contents.length === 0) return { ok: false, reason: 'no-user-message' };

  const tokens = contents.map(extractToken);
  // 1 つでも発行の記録が無い発話があれば、そのターンに誰がいたのか分からない。
  // 引けた分だけで多数決すると、未登録 sender の発話が混ざったターンを
  // 「1 人分」と誤認する (fail-open) ので、ここで断つ。
  if (tokens.some((t) => t === null)) return { ok: false, reason: 'unresolved' };

  const resolved = (tokens as string[]).map((t) => resolveSenderToken(t, now));
  if (resolved.some((r) => r === null)) return { ok: false, reason: 'expired' };

  const rows = resolved as SenderToken[];
  // 発行時の session / agent group と一致しない行は、別セッション由来のものが
  // 紛れ込んでいる。数に入れず断る。
  if (rows.some((r) => r.session_id !== sessionId || r.agent_group_id !== agentGroupId)) {
    return { ok: false, reason: 'unresolved' };
  }

  const userIds = new Set(rows.map((r) => r.user_id));
  if (userIds.size > 1) return { ok: false, reason: 'mixed-senders' };

  return { ok: true, userId: rows[0].user_id, token: rows[0] };
}

/**
 * 処理中のユーザー発話の content を集める。
 *
 * DB が無い / 壊れている場合は空配列。ここで throw すると CLI 要求そのものが
 * 落ちるが、返すべきは「依頼者が分からない」であって障害ではない。
 */
function readProcessingUserMessages(agentGroupId: string, sessionId: string): string[] {
  let ids: string[];
  try {
    const outbound = openOutboundDb(outboundDbPath(agentGroupId, sessionId));
    try {
      ids = (
        outbound.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
          message_id: string;
        }>
      ).map((r) => r.message_id);
    } finally {
      outbound.close();
    }
  } catch (err) {
    log.warn('Turn sender: processing_ack unreadable', { sessionId, err });
    return [];
  }
  if (ids.length === 0) return [];

  try {
    const inbound = openInboundDb(inboundDbPath(agentGroupId, sessionId));
    try {
      const idPlaceholders = ids.map(() => '?').join(',');
      const kindPlaceholders = USER_MESSAGE_KINDS.map(() => '?').join(',');
      const rows = inbound
        .prepare(
          `SELECT content FROM messages_in
            WHERE id IN (${idPlaceholders}) AND kind IN (${kindPlaceholders})`,
        )
        .all(...ids, ...USER_MESSAGE_KINDS) as Array<{ content: string }>;
      return rows.map((r) => r.content);
    } finally {
      inbound.close();
    }
  } catch (err) {
    log.warn('Turn sender: messages_in unreadable', { sessionId, err });
    return [];
  }
}

function extractToken(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { senderToken?: unknown };
    return typeof parsed.senderToken === 'string' ? parsed.senderToken : null;
  } catch {
    return null;
  }
}
