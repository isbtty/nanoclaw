/**
 * `/update-knowledge-scope` — on-demand re-issue of a channel's knowledge-scope
 * edit link (deshi-update-knowledge-scope skill).
 *
 * Chat-triggered owner command. When an owner/admin of the agent group sends
 * `/update-knowledge-scope` in a channel, we mint a fresh time-limited
 * scope-edit link (same as the connect-time onboarding link) and DM it to
 * them, then acknowledge in the channel. Non-owner senders get a
 * "not permitted" reply and nothing is minted.
 *
 * Lives on the router's command path (`deliverToAgent`, before the generic
 * `gateCommand`): a handled command never reaches the container / deshi
 * passthrough. Authorization reuses `hasAdminPrivilege` — the same gate that
 * guards setting scope from the registration card — so "owner" here means the
 * same owner/admin set.
 */
import { log } from '../../log.js';
import { writeOutboundDirect } from '../../session-manager.js';
import { maybeDeliverScopeLink } from './channel-scope-link.js';
import { hasAdminPrivilege } from './db/user-roles.js';

export const KNOWLEDGE_SCOPE_COMMAND = '/update-knowledge-scope';

interface DeliveryAddr {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

export interface KnowledgeScopeCommandInput {
  content: string;
  userId: string | null;
  agentGroupId: string;
  messagingGroupId: string;
  sessionId: string;
  deliveryAddr: DeliveryAddr;
}

/** Parse the `{text}` payload (or raw string) and return the leading token. */
function leadingToken(content: string): string {
  let text: string;
  try {
    text = (JSON.parse(content).text ?? '').trim();
  } catch {
    text = content.trim();
  }
  return text.split(/\s/)[0].toLowerCase();
}

function reply(input: KnowledgeScopeCommandInput, text: string): void {
  writeOutboundDirect(input.agentGroupId, input.sessionId, {
    id: `kscope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    platformId: input.deliveryAddr.platformId,
    channelType: input.deliveryAddr.channelType,
    threadId: input.deliveryAddr.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Handle `/update-knowledge-scope`. Returns true when the message was this
 * command (and has been answered) so the router stops processing it; false
 * otherwise so normal routing continues.
 */
export async function handleKnowledgeScopeCommand(input: KnowledgeScopeCommandInput): Promise<boolean> {
  if (leadingToken(input.content) !== KNOWLEDGE_SCOPE_COMMAND) return false;

  if (!input.userId || !hasAdminPrivilege(input.userId, input.agentGroupId)) {
    log.info('Knowledge-scope command denied — not an owner/admin', {
      userId: input.userId,
      agentGroupId: input.agentGroupId,
    });
    reply(input, 'この操作はオーナー（管理者）のみ実行できます。');
    return true;
  }

  const result = await maybeDeliverScopeLink(input.agentGroupId, input.messagingGroupId, input.userId);

  if (result.ok) {
    reply(input, '📩 知識の編集リンクを DM に送りました（10分有効・1回限り）。DM を確認してください。');
  } else if (result.reason === 'not-deshi') {
    reply(input, 'このチャンネルは知識スコープ編集に対応していません（deshi 連携グループ専用）。');
  } else if (result.reason === 'no-dm') {
    reply(input, 'DM 宛先が見つかりませんでした。一度ボットに DM を送ってから再度お試しください。');
  } else {
    reply(input, 'リンクの生成に失敗しました。時間をおいて再度お試しください。');
  }
  return true;
}
