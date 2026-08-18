/**
 * "Reject with reason…" capture flow.
 *
 * When an admin clicks the third approval button, the reject is held instead of
 * finalized: the row is parked at status='awaiting_reason' and the admin is
 * prompted in their DM for a one-line reason. Their next DM (≤ 280 chars) is
 * captured by a router message-interceptor and relayed to the requesting agent
 * as one combined message — `Your <action> request was rejected by admin:
 * "<reason>"`. A plain Reject never arms this, so an unrelated DM is never
 * swallowed.
 *
 * Restart-safety: arming lives in an in-memory map (lost on restart, like the
 * agent-naming capture it mirrors), but the hold is a durable DB row. If the
 * admin never replies — or the host restarts mid-capture — the host sweep
 * (sweepAwaitingReasonRejects, run each tick) finalizes a plain reject once the
 * row's window elapses, so the requesting agent is never stranded.
 *
 * Reuses, not reinvents: the agent-naming prompt-then-capture pattern
 * (in-memory map + next-DM interceptor) and the shared finalizeReject path.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { getDeliveryAdapter } from '../../delivery.js';
import {
  deletePendingApproval,
  getExpiredAwaitingReasonApprovals,
  getPendingApproval,
  getSession,
  markApprovalAwaitingReason,
} from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import type { PendingApproval, Session } from '../../types.js';
import { parseSender } from '../permissions/sender-identity.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { finalizeReject } from './finalize.js';

/** How long an awaiting-reason hold waits for the admin's reply before the sweep finalizes a plain reject. */
const REASON_CAPTURE_WINDOW_MS = 5 * 60 * 1000;
/** Cap on the relayed reason — one cheap guardrail against a wall of text landing in another team's agent context. */
const MAX_REASON_LEN = 280;

const PROMPT_TEXT =
  "Reply with a one-line reason for the rejection — I'll relay it to the agent. " +
  'No reply within ~5 min declines it without a reason.';

interface ReasonArming {
  approvalId: string;
  /** Namespaced id of the admin who clicked, for resolution attribution. */
  userId: string;
}

/**
 * Approvers waiting to type a rejection reason, keyed by the channel the prompt
 * was delivered to (`<channelType>:<platformId>`).
 *
 * The key alone is not enough to identify whose reply this is: an approver's DM
 * can be redirected to a shared channel, and there several admins share one key
 * and everyone else's messages land on it too. So each key holds a *list* of
 * armings and consumption matches on the sender — a bystander's message is left
 * to route normally instead of being swallowed as someone else's reason.
 *
 * Cleared on receipt, staleness, or restart.
 */
const awaitingReason = new Map<string, ReasonArming[]>();

/**
 * Arm for one sender. A second arming by the same admin replaces the first —
 * they can only be typing one reason, and the superseded hold is a durable row
 * the sweep finalizes. Other admins on the same channel are untouched.
 */
function arm(key: string, arming: ReasonArming): void {
  const list = awaitingReason.get(key);
  if (!list) {
    awaitingReason.set(key, [arming]);
    return;
  }
  const existing = list.findIndex((a) => a.userId === arming.userId);
  if (existing >= 0) list[existing] = arming;
  else list.push(arming);
}

/** Remove one arming by index, dropping the key when it empties. */
function disarm(key: string, list: ReasonArming[], index: number): void {
  list.splice(index, 1);
  if (list.length === 0) awaitingReason.delete(key);
}

function dmKey(channelType: string, platformId: string): string {
  return `${channelType}:${platformId}`;
}

function clampReason(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_REASON_LEN) return trimmed;
  return trimmed.slice(0, MAX_REASON_LEN - 1) + '…';
}

function extractText(event: InboundEvent): string {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

/**
 * Begin the reject-with-reason hold for an approval the admin chose not to
 * finalize outright. Prompts the admin's DM, then parks the row and arms
 * capture. If we can't reach the admin (no DM, no adapter, delivery throws) we
 * finalize a plain reject immediately rather than strand the requesting agent.
 */
export async function armReasonCapture(approval: PendingApproval, session: Session, userId: string): Promise<void> {
  const dm = userId ? await ensureUserDm(userId) : null;
  const adapter = getDeliveryAdapter();
  if (!dm || !adapter) {
    log.warn('reject-with-reason: cannot reach approver, finalizing plain reject', {
      approvalId: approval.approval_id,
      userId,
      hasDm: Boolean(dm),
      hasAdapter: Boolean(adapter),
    });
    await finalizeReject(approval, session, userId);
    return;
  }

  try {
    await adapter.deliver(dm.channel_type, dm.platform_id, null, 'chat-sdk', JSON.stringify({ text: PROMPT_TEXT }));
  } catch (err) {
    log.error('reject-with-reason: reason prompt delivery failed, finalizing plain reject', {
      approvalId: approval.approval_id,
      err,
    });
    await finalizeReject(approval, session, userId);
    return;
  }

  // Prompt is out — now hold the row and arm capture. Order matters: a reply
  // can't arrive before the prompt is read, so there's no lost-message window.
  const expiresAt = new Date(Date.now() + REASON_CAPTURE_WINDOW_MS).toISOString();
  markApprovalAwaitingReason(approval.approval_id, expiresAt);
  arm(dmKey(dm.channel_type, dm.platform_id), { approvalId: approval.approval_id, userId });
  log.info('reject-with-reason: awaiting reason reply', { approvalId: approval.approval_id, userId });
}

/**
 * Router message-interceptor: capture the next message from an admin who armed
 * a reason. Returns true (consume the message) when the sender has a live
 * arming on this channel; false otherwise so normal routing runs.
 *
 * Runs ahead of the router's sender resolution, so the sender is parsed here.
 *
 * Exported for tests; registered as the interceptor below.
 */
export async function captureReasonReply(event: InboundEvent): Promise<boolean> {
  const key = dmKey(event.channelType, event.platformId);
  const list = awaitingReason.get(key);
  if (!list) return false;

  // Match on the sender: a shared approvals channel carries other people's
  // messages too, and swallowing those would drop them from routing entirely.
  const senderId = parseSender(event).userId;
  const index = list.findIndex((a) => a.userId === senderId);
  if (index < 0) return false;
  const arming = list[index];

  // This sender's arming fires — disarm it regardless of outcome. Other
  // approvers armed on the same channel keep waiting.
  disarm(key, list, index);

  const approval = getPendingApproval(arming.approvalId);
  if (!approval || approval.status !== 'awaiting_reason') {
    // Already finalized (e.g. ghosted by the sweep). The reply is no longer a
    // reason — let it route normally instead of swallowing it.
    return false;
  }

  const session = approval.session_id ? getSession(approval.session_id) : null;
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return true;
  }

  const reason = clampReason(extractText(event));
  await finalizeReject(approval, session, arming.userId, reason || undefined);
  log.info('reject-with-reason: reason captured and relayed', {
    approvalId: approval.approval_id,
    hasReason: reason.length > 0,
  });
  return true;
}

registerMessageInterceptor(captureReasonReply);

/**
 * Host-sweep finalizer: any reject-with-reason hold whose window elapsed (admin
 * ghosted, or the host restarted mid-capture and lost the in-memory arming) is
 * finalized as a plain reject. Restart-safe — the hold is a durable row, so the
 * requesting agent always gets its decision. Called once per sweep tick.
 */
export async function sweepAwaitingReasonRejects(): Promise<void> {
  const rows = getExpiredAwaitingReasonApprovals(new Date().toISOString());
  for (const approval of rows) {
    const session = approval.session_id ? getSession(approval.session_id) : null;
    if (!session) {
      deletePendingApproval(approval.approval_id);
      continue;
    }
    // Plain reject, unknown resolver — the admin opted in but never typed.
    await finalizeReject(approval, session, '');
    log.info('reject-with-reason: window elapsed, finalized as plain reject', { approvalId: approval.approval_id });
  }
}
