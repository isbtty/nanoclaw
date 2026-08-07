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
 * ターンに複数人の発言が混ざっている場合は、どちらの依頼か機械的に決められない
 * ので `mixed-senders` で断る (fail-closed)。同一人物の複数発言は曖昧ではない
 * ので通す。
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
  | { ok: false; reason: 'no-token' | 'expired' | 'mixed-senders' };

/**
 * このターンの依頼者を引く。呼び出し側は `ok: false` を「権限が要る操作は断る」
 * として扱う。
 */
export function resolveTurnSender(agentGroupId: string, sessionId: string, now: Date = new Date()): TurnSender {
  const tokens = readProcessingTokens(agentGroupId, sessionId);
  if (tokens.length === 0) return { ok: false, reason: 'no-token' };

  const resolved = tokens.map((t) => resolveSenderToken(t, now)).filter((r): r is SenderToken => r !== null);
  if (resolved.length === 0) return { ok: false, reason: 'expired' };

  const userIds = new Set(resolved.map((r) => r.user_id));
  if (userIds.size > 1) return { ok: false, reason: 'mixed-senders' };

  return { ok: true, userId: resolved[0].user_id, token: resolved[0] };
}

/**
 * 処理中メッセージの content から senderToken を集める。
 *
 * DB が無い / 壊れている場合は空配列。ここで throw すると CLI 要求そのものが
 * 落ちるが、返すべきは「依頼者が分からない」であって障害ではない。
 */
function readProcessingTokens(agentGroupId: string, sessionId: string): string[] {
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
      const placeholders = ids.map(() => '?').join(',');
      const rows = inbound
        .prepare(`SELECT content FROM messages_in WHERE id IN (${placeholders})`)
        .all(...ids) as Array<{ content: string }>;
      return rows.map((r) => extractToken(r.content)).filter((t): t is string => t !== null);
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
