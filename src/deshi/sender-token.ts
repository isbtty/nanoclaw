/**
 * Sender tokens — container 経由の呼び出しで「誰の依頼か」を host が権威的に
 * 決めるための仕組み (.deshi/adr/0020-sender-token.md)。
 *
 * host は inbound メッセージをセッションへ書くときにトークンを 1 つ発行し、
 * message content に同梱する。container の agent は `ncl` や host-tool を叩く
 * ときに、いま処理しているユーザー発話のトークンを添える。host 側は
 * {@link resolveSenderToken} で発言者と channel を引き直し、**引数で渡された
 * user / channelId は採用しない**。
 *
 * トークンは同一メッセージから何度でも使える。1 つの依頼が複数の CLI 呼び出しに
 * 分かれる (group 作成 → wiring → role 付与) ため、単回使用にすると成立しない。
 * 代わりに TTL を短く保ち、実行側が「誰の権限で実行したか」を可視化する。
 */
import { randomBytes } from 'node:crypto';

import { getDb } from '../db/connection.js';
import { log } from '../log.js';

/**
 * トークンの寿命。短いほど「古い依頼が後から復活する」窓が狭まる。
 * 1 つの依頼を処理しきるには十分で、セッションを跨いで生き残らない長さ。
 */
export const SENDER_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface SenderToken {
  token: string;
  user_id: string;
  messaging_group_id: string;
  agent_group_id: string;
  session_id: string;
  issued_at: string;
  expires_at: string;
}

export interface IssueSenderTokenInput {
  userId: string;
  messagingGroupId: string;
  agentGroupId: string;
  sessionId: string;
  /** 発行時刻。省略時は現在時刻 (テストから固定するための口)。 */
  now?: Date;
}

/**
 * inbound 1 件分のトークンを発行して控える。返り値を message content に載せる。
 *
 * 推測不能であることが前提の値なので、`randomUUID` ではなく 192bit の乱数を
 * base64url で表現する (URL / JSON / シェル引数のどこに置いても安全な字種)。
 */
export function issueSenderToken(input: IssueSenderTokenInput): string {
  const now = input.now ?? new Date();
  const token = randomBytes(24).toString('base64url');
  getDb()
    .prepare(
      `INSERT INTO sender_tokens
         (token, user_id, messaging_group_id, agent_group_id, session_id, issued_at, expires_at)
       VALUES (@token, @user_id, @messaging_group_id, @agent_group_id, @session_id, @issued_at, @expires_at)`,
    )
    .run({
      token,
      user_id: input.userId,
      messaging_group_id: input.messagingGroupId,
      agent_group_id: input.agentGroupId,
      session_id: input.sessionId,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SENDER_TOKEN_TTL_MS).toISOString(),
    });
  return token;
}

/**
 * トークンから発言者と channel を引く。未知・期限切れは `null` (fail-closed)。
 *
 * 期限切れの行はここでは消さない。掃除は {@link sweepExpiredSenderTokens} に
 * 任せて、読み取り経路を副作用なしに保つ。
 */
export function resolveSenderToken(token: string, now: Date = new Date()): SenderToken | null {
  if (!token) return null;
  const row = getDb().prepare('SELECT * FROM sender_tokens WHERE token = ?').get(token) as SenderToken | undefined;
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) return null;
  return row;
}

/**
 * inbound の content にトークンを差し込んで返す。router がセッションへ書き込む
 * 直前に通す唯一の発行地点。
 *
 * 何もせず content をそのまま返すのは次の場合:
 *   - 発言者を特定できない (permissions モジュール無し、または adapter が
 *     author を載せない) — トークンが無ければ後段は fail-closed に倒れる
 *   - content が JSON オブジェクトでない — 差し込む場所が無い
 *
 * 発行に失敗してもメッセージ配送は止めない。トークンはあくまで権限判定の材料で、
 * ここで throw すると「権限を使わない普通の会話まで届かなくなる」ため割に合わない。
 */
export function stampSenderToken(
  content: string,
  ctx: { userId: string | null; messagingGroupId: string; agentGroupId: string; sessionId: string },
): string {
  if (!ctx.userId) return content;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return content;

  try {
    const token = issueSenderToken({
      userId: ctx.userId,
      messagingGroupId: ctx.messagingGroupId,
      agentGroupId: ctx.agentGroupId,
      sessionId: ctx.sessionId,
    });
    return JSON.stringify({ ...parsed, senderToken: token });
  } catch (err) {
    log.warn('Sender token issue failed — message delivered without one', {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      err,
    });
    return content;
  }
}

/** 期限切れトークンを削除して件数を返す。host-sweep から定期的に呼ぶ。 */
export function sweepExpiredSenderTokens(now: Date = new Date()): number {
  return getDb().prepare('DELETE FROM sender_tokens WHERE expires_at <= ?').run(now.toISOString()).changes;
}
