/**
 * Tell a human when a session's container keeps dying at boot.
 *
 * Rides the approvals module's approver resolution (scoped admins → global
 * admins → owners, then the first one with a reachable DM) and the delivery
 * adapter's plain-text send. There is no dedicated "admin notification"
 * primitive in the host; this is the same path approval cards take, minus
 * the card. Best-effort: never throws, never blocks the caller.
 *
 * Fired by container-runner when the spawn backoff *escalates* (the delay
 * steps up: 3rd, 4th and 5th consecutive early failure), so a looping
 * session produces three DMs over ~20 minutes, then goes quiet until the
 * record resets or the operator fixes it. The log line is the primary
 * signal; this is the one that reaches a phone.
 */
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { pickApprovalDelivery, pickApprover } from './modules/approvals/primitive.js';
import type { Session } from './types.js';

export interface CrashLoopAlert {
  failures: number;
  delayMs: number;
  lastExitCode: number | null;
  stderrTail: string[];
}

export function formatCrashLoopAlert(session: Session, agentGroupName: string | null, a: CrashLoopAlert): string {
  const mins = Math.round(a.delayMs / 60000);
  const tail = a.stderrTail.length ? `\n\nlast stderr:\n${a.stderrTail.slice(-5).join('\n')}` : '';
  return (
    `⚠️ NanoClaw: agent "${agentGroupName ?? session.agent_group_id}" (session ${session.id}) ` +
    `has crashed ${a.failures}× within 30s of starting (last exit code ${a.lastExitCode ?? '?'}). ` +
    `Holding respawns for ${mins} min. Check logs/nanoclaw.error.log for "early-exit backoff".` +
    tail
  );
}

export async function alertSessionCrashLoop(session: Session, alert: CrashLoopAlert): Promise<void> {
  try {
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    const approvers = pickApprover(session.agent_group_id);
    if (approvers.length === 0) return;
    const originChannelType = session.messaging_group_id
      ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
      : '';
    const target = await pickApprovalDelivery(approvers, originChannelType);
    if (!target) return;
    const text = formatCrashLoopAlert(session, getAgentGroup(session.agent_group_id)?.name ?? null, alert);
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text }),
    );
    log.info('Sent crash-loop alert', { sessionId: session.id, to: target.userId, failures: alert.failures });
  } catch (err) {
    log.warn('Crash-loop alert failed (logs remain the source of truth)', { sessionId: session.id, err });
  }
}
