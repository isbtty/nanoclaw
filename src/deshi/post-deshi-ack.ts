/**
 * deshi 委譲の「中間返信 (一次 ack)」を host 側で構造的に配信する。
 *
 * 背景 (isbtty/deshi#423):
 *   deshi 委譲 (`deshi_run_start` → `deshi_run_poll`) で実行に数分かかる間、
 *   ユーザーが無音で待たされる事象が継続。本来は agent が run_start 直後に
 *   「確認しています」程度の中間返信を返す設計だが、prompt 指示 (CLAUDE.md /
 *   delegation fragment) に依存しており、agent が ack を `<message>` で wrap
 *   し忘れる等で届かないケースが繰り返し発生した (#416 と同型の LLM 非決定性)。
 *
 *   そこで「遅い job のときだけ」host が messages_out に ack を構造配信する。
 *   呼び出し元は `deshi_daemon_poll_until_done` handler で、poll が閾値秒を
 *   超えても pending のときに 1 回だけ本関数を呼ぶ。fast job では呼ばれない。
 *
 * 実装は inbound notification (skill-execution-notifications.ts) と同じ
 * session 解決 + messages_out 書き込み経路を再利用する。messages_out のみ
 * 書く (messages_in には書かない) — ack は user へ届けばよく、agent の
 * context に乗せる必要は無いため。
 */

import { randomUUID } from 'node:crypto';

import { getMessagingGroupByPlatform, getMessagingGroupAgents } from '../db/messaging-groups.js';
import { resolveSession, outboundDbPath } from '../session-manager.js';
import { openOutboundDbRw } from '../db/session-db.js';
import { log } from '../log.js';
import {
  SUPPORTS_THREADS,
  computeEffectiveSessionMode,
  writeOutboundMessage,
} from './inbound/skill-execution-notifications.js';

export interface DeshiAckChannelContext {
  channel: string;
  platformId: string;
  threadId?: string;
}

const DEFAULT_ACK_TEXT = '確認しています。少々お待ちください 🔎';

function ackText(): string {
  const t = process.env.DESHI_RUN_ACK_TEXT;
  return t && t.trim() !== '' ? t : DEFAULT_ACK_TEXT;
}

const DEFAULT_ACK_COOLDOWN_MS = 10 * 60 * 1000; // 同一 session+thread で ack を再送しない期間

/**
 * 中間 ack の重複抑止 cooldown (ms)。`deshi_daemon_poll_until_done` handler の
 * `ackSent` フラグは 1 呼び出しスコープしか効かないため、agent が 1 発話に対し
 * run_skill+poll を複数サイクル回す / 再 poll するたびに独立して ack が書かれ、
 * ユーザーには同一 ack が連投される (isbtty/deshi#451)。session+thread 単位で
 * 直近 cooldown 内に既存 ack があれば skip し、process 再起動も跨げるよう
 * messages_out を参照して判定する。
 */
function ackCooldownMs(): number {
  const raw = process.env.DESHI_RUN_ACK_COOLDOWN_MS;
  if (!raw) return DEFAULT_ACK_COOLDOWN_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ACK_COOLDOWN_MS;
}

/**
 * 同一 session+thread で直近 cooldown 内に配信済みの `deshi-ack-*` 行があるか。
 * messages_out.timestamp は `datetime('now')` (UTC text) で書かれるため、
 * `datetime('now', '-N seconds')` と文字列比較できる。cooldown=0 のときは無効化
 * (常に false = 抑止しない)。
 */
function hasRecentAck(agentGroupId: string, sessionId: string, threadId: string | null, cooldownMs: number): boolean {
  if (cooldownMs <= 0) return false;
  const db = openOutboundDbRw(outboundDbPath(agentGroupId, sessionId));
  try {
    const cutoff = `-${Math.ceil(cooldownMs / 1000)} seconds`;
    const row = db
      .prepare(
        `SELECT 1 FROM messages_out
         WHERE id LIKE 'deshi-ack-%'
           AND (thread_id IS ? OR (thread_id IS NULL AND ? IS NULL))
           AND timestamp >= datetime('now', ?)
         LIMIT 1`,
      )
      .get(threadId, threadId, cutoff);
    return row !== undefined;
  } catch (err) {
    // 判定 DB アクセスが失敗しても本体の ack を止めない (fail-open)
    log.warn('hasRecentAck check failed', { err: String(err) });
    return false;
  } finally {
    db.close();
  }
}

/**
 * 中間 ack を該当 session の messages_out に 1 行書き込む。host の delivery
 * polling が pickup して channel に配信する。失敗は throw せず warn ログのみ
 * (ack 配信失敗で本体の polling を止めない)。
 *
 * @returns 書き込めたら true、session 解決失敗等で skip したら false
 */
export function postDeshiRunAck(ctx: DeshiAckChannelContext): boolean {
  try {
    const mg = getMessagingGroupByPlatform(ctx.channel, ctx.platformId);
    if (!mg) {
      log.warn('postDeshiRunAck: messaging_group not found', {
        channel: ctx.channel,
        platformId: ctx.platformId,
      });
      return false;
    }

    const agents = getMessagingGroupAgents(mg.id);
    if (agents.length === 0) {
      log.warn('postDeshiRunAck: no agent wired', { messagingGroupId: mg.id });
      return false;
    }
    const agent = agents[0]!;

    const adapterSupportsThreads = SUPPORTS_THREADS[ctx.channel] ?? false;
    const effectiveSessionMode = computeEffectiveSessionMode(agent.session_mode, adapterSupportsThreads, mg.is_group);

    const { session } = resolveSession(agent.agent_group_id, mg.id, ctx.threadId ?? null, effectiveSessionMode);

    const threadId = ctx.threadId ?? session.thread_id ?? null;

    // 同一 session+thread で直近 cooldown 内に ack 済みなら連投を抑止する (#451)。
    if (hasRecentAck(agent.agent_group_id, session.id, threadId, ackCooldownMs())) {
      log.info('postDeshiRunAck: suppressed duplicate ack (cooldown)', {
        agentGroupId: agent.agent_group_id,
        sessionId: session.id,
        threadId,
      });
      return false;
    }

    writeOutboundMessage({
      agentGroupId: agent.agent_group_id,
      sessionId: session.id,
      id: `deshi-ack-${randomUUID()}`,
      kind: 'chat',
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId,
      content: JSON.stringify({ text: ackText(), files: [] }),
    });
    return true;
  } catch (err) {
    log.warn('postDeshiRunAck failed', { err: String(err) });
    return false;
  }
}
