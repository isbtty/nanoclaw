/**
 * Delivery-failure notification (isbtty/deshi#491, 段2).
 *
 * When core dead-letters a message — a permanent error, or a transient failure
 * that never recovered within the time ceiling — the owner should hear about it
 * instead of the reply silently vanishing. This module hooks core's onDeadLetter
 * and:
 *   1. Sends the owner/admin an approval card ("an error occurred delivering a
 *      reply — investigate?"). Approving runs /deshi-feedback-gh, which opens a
 *      GitHub issue capturing the failure.
 *   2. Best-effort apology to the chat whose reply was lost, so the waiting user
 *      is not left in silence.
 *
 * Storm suppression: a broken channel dead-letters every queued message, so we
 * emit at most one owner card per (agent group + error class) per cooldown.
 *
 * NOTE: the owner alert is delivered via requestApproval, which routes to an
 * owner/admin DM. If a future requirement moves approval cards to a separate
 * channel (e.g. a Slack channel for team-operated bots), the failure/alert
 * routing must be split out into its own logic — where an error alert lands is a
 * different concern from where an approval card lands.
 */
import { onDeadLetter, getDeliveryAdapter, type DeadLetterEvent } from '../../delivery.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import {
  requestApproval,
  registerApprovalHandler,
  pickApprover,
  pickApprovalDelivery,
} from '../approvals/primitive.js';
import type { MessagingGroup } from '../../types.js';

const ACTION = 'investigate_delivery_failure';
const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;

/** Last owner-alert time per `${agentGroupId}:${errorClass}`. In-memory: a
 *  restart resets the cooldown, which is acceptable (worst case one extra card). */
const lastNotified = new Map<string, number>();

function errorClass(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  return name && name.length > 0 ? name : 'Error';
}

onDeadLetter(async (ev) => {
  // Only user-facing channel messages warrant a notification. Internal traffic
  // (agent-to-agent routing, system actions) is covered by the dead-letter log.
  if (!ev.msg.channel_type || ev.msg.channel_type === 'agent' || ev.msg.kind === 'system') return;
  await alertOwner(ev);
  await apologizeToChat(ev);
});

/** Owner/admin approval card, storm-deduped. requestApproval swallows its own
 *  delivery failures, so this only guards against unexpected throws. */
async function alertOwner(ev: DeadLetterEvent): Promise<void> {
  const cls = errorClass(ev.err);
  const key = `${ev.session.agent_group_id}:${cls}`;
  const now = Date.now();
  const last = lastNotified.get(key);
  if (last !== undefined && now - last < NOTIFY_COOLDOWN_MS) return; // storm suppression
  lastNotified.set(key, now);

  const agentName = getAgentGroup(ev.session.agent_group_id)?.name ?? 'agent';
  try {
    await requestApproval({
      session: ev.session,
      agentName,
      action: ACTION,
      // JSON-safe, no message body / PII — only technical identifiers.
      payload: {
        messageId: ev.msg.id,
        errorClass: cls,
        reason: ev.reason,
        channelType: ev.msg.channel_type,
      },
      title: '返信の配送に失敗しました',
      question: `エラーが発生し、返信をお届けできませんでした（種別: ${cls}）。原因を調査してよろしいですか？`,
    });
  } catch (err) {
    log.error('delivery-notify: owner alert failed', { key, err });
  }
}

/** Best-effort apology to the chat whose reply was lost. Never throws — the same
 *  channel may be broken (that is often why we are here), and a failed apology
 *  must not cascade back into the delivery path. */
async function apologizeToChat(ev: DeadLetterEvent): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter || !ev.msg.channel_type || !ev.msg.platform_id) return;
  try {
    await adapter.deliver(
      ev.msg.channel_type,
      ev.msg.platform_id,
      ev.msg.thread_id,
      'chat-sdk',
      JSON.stringify({
        text: '申し訳ありません、先ほどの返信をお届けできませんでした。担当者に調査を依頼しました。',
      }),
    );
  } catch (err) {
    log.warn('delivery-notify: apology to chat failed (best-effort)', { messageId: ev.msg.id, err });
  }
}

/** Deliver a status line to a specific DM (the owner's), best-effort. */
async function tellDm(dm: MessagingGroup, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(dm.channel_type, dm.platform_id, null, 'chat-sdk', JSON.stringify({ text }));
  } catch (err) {
    log.warn('delivery-notify: status DM failed (best-effort)', { err });
  }
}

/** On approve, ask deshi-general to open a GitHub issue for the failure.
 *  Output routes to the owner's DM.
 *
 *  Routed through /deshi-general (not /deshi-feedback-gh directly): feedback-gh
 *  is not exposed to nanoclaw (`expose-to-nanoclaw: false`), so a direct /run
 *  is rejected by the daemon's nanoclaw allowlist. deshi-general IS exposed and
 *  orchestrates running feedback-gh internally (the "worker-skill 直叩き" pattern,
 *  isbtty/deshi ADR-0010).
 *
 *  We re-derive the owner DM via pickApprovalDelivery rather than trusting the
 *  approval context: ctx.userId is the bare platform id (no namespace) so
 *  ensureUserDm can't resolve it, and ctx.notify writes to the agent's own
 *  session — which surfaces in the agent's customer-facing chat, not the owner's
 *  DM. All status/output here must land in the owner DM instead. */
registerApprovalHandler(ACTION, async ({ session, payload }) => {
  const reason = String(payload.reason ?? 'permanent');
  const cls = String(payload.errorClass ?? 'Error');
  const channelType = String(payload.channelType ?? '');
  const messageId = String(payload.messageId ?? '');

  const target = await pickApprovalDelivery(pickApprover(session.agent_group_id), '');
  if (!target) {
    log.warn('delivery-notify: approve handler — no reachable approver DM', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }
  const dm = target.messagingGroup;

  const input =
    `/deshi-general nanoclaw の配送が dead-letter しました` +
    `（reason=${reason} errorClass=${cls} channel=${channelType} messageId=${messageId}）。` +
    `/deshi-feedback-gh を実行して、この配送障害を GitHub issue として起票してください。`;

  const deshiUrl = process.env.DESHI_DAEMON_URL ?? 'http://localhost:3100';
  try {
    const res = await fetch(`${deshiUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        channelContext: { channel: dm.channel_type, platformId: dm.platform_id, threadId: null },
      }),
    });
    if (!res.ok) {
      await tellDm(dm, `調査スキルの起動に失敗しました（deshi /run ${res.status}）。`);
      return;
    }
    // Success: the feedback-gh skill reports the created issue to this same DM.
  } catch (err) {
    log.error('delivery-notify: deshi /run failed', { err });
    await tellDm(dm, '調査スキルの起動に失敗しました（deshi daemon に接続できません）。');
  }
});
