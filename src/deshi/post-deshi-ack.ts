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
import { resolveSession } from '../session-manager.js';
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

    writeOutboundMessage({
      agentGroupId: agent.agent_group_id,
      sessionId: session.id,
      id: `deshi-ack-${randomUUID()}`,
      kind: 'chat',
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: ctx.threadId ?? session.thread_id ?? null,
      content: JSON.stringify({ text: ackText(), files: [] }),
    });
    return true;
  } catch (err) {
    log.warn('postDeshiRunAck failed', { err: String(err) });
    return false;
  }
}
