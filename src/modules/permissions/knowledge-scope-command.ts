/**
 * `/update-knowledge-scope` — on-demand re-issue of a channel's knowledge-scope
 * edit link (deshi-update-knowledge-scope skill).
 *
 * Chat-triggered command. Triggered by the explicit command only — the
 * `/update-knowledge-scope` slash command or the skill name typed directly
 * (`deshi-update-knowledge-scope`, with/without `/`). Natural-language
 * requests ("公開範囲を編集したい" etc.) are NOT matched here; the deshi
 * delegation fragment guides those to send this command, keeping nanoclaw
 * free of keyword matching. When an owner/admin triggers it, we mint a fresh
 * time-limited scope-edit link (same as the connect-time onboarding link) and
 * DM it to them, then acknowledge in the channel.
 *
 * A non-owner (or unidentifiable) sender does NOT get the link — the request
 * is forwarded to the owner's DM with context (which channel, who asked) so
 * the owner can set the scope. The requester gets a link-free ack. The link
 * never appears in the channel: anyone who opens it can edit the scope, so it
 * must stay in the owner's DM.
 *
 * Lives on the router's command path (`deliverToAgent`, before the generic
 * `gateCommand`): a handled command never reaches the container / deshi
 * passthrough. Authorization reuses `hasAdminPrivilege` — the same gate that
 * guards setting scope from the registration card — so "owner" here means the
 * same owner/admin set.
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { pickApprover } from '../approvals/primitive.js';
import { maybeDeliverScopeLink, type ScopeLinkResult } from './channel-scope-link.js';
import { hasAdminPrivilege } from './db/user-roles.js';

export const KNOWLEDGE_SCOPE_COMMAND = '/update-knowledge-scope';

// Recognized as the leading token: the slash command and the skill name
// (with/without the `/` and the `deshi-` prefix). Exact match only — natural
// language ("公開範囲を編集したい" etc.) is NOT matched here. Fuzzy intent is
// the deshi agent's job: the delegation fragment guides such requests to send
// this command, so nanoclaw stays free of brittle keyword matching.
const COMMAND_ALIASES = new Set([
  KNOWLEDGE_SCOPE_COMMAND,
  '/deshi-update-knowledge-scope',
  'deshi-update-knowledge-scope',
  'update-knowledge-scope',
]);

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
  deliveryAddr: DeliveryAddr;
}

/** Extract the `{text}` payload (or raw string). */
function parseText(content: string): string {
  try {
    return (JSON.parse(content).text ?? '').trim();
  } catch {
    return content.trim();
  }
}

/**
 * Sender display name from the message payload, if the adapter included one
 * (LINE attaches `senderName` per message). Falls back to undefined so the
 * caller can use the raw user id.
 */
function parseSenderName(content: string): string | undefined {
  try {
    const name = JSON.parse(content).senderName;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  line: 'LINE',
  slack: 'Slack',
  telegram: 'Telegram',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  teams: 'Teams',
  gchat: 'Google Chat',
  matrix: 'Matrix',
  webex: 'Webex',
};

/**
 * Human-readable origin for the forwarded request so the owner can tell where
 * it came from (e.g. "LINEグループ", "Slack DM"). Prefers a resolved channel
 * name when one exists, else falls back to "<platform>グループ/DM" — no API
 * call needed (derived from channel_type + is_group).
 */
function channelSource(
  channel: { name?: string | null; channel_type?: string; is_group?: number } | undefined,
): string {
  if (channel?.name) return channel.name;
  const type = channel?.channel_type;
  const label = (type && CHANNEL_TYPE_LABELS[type]) || (type ? type[0].toUpperCase() + type.slice(1) : 'チャンネル');
  return channel?.is_group ? `${label}グループ` : `${label} DM`;
}

/**
 * Strip leading platform mention tokens so an addressed command still matches.
 * In mention-required groups (Slack/Discord) the user naturally types
 * `@bot update-knowledge-scope`, which arrives as `<@Ubot> update-knowledge-scope`
 * — the command is no longer the first token. We drop one or more leading
 * mentions (Slack `<@U123>` / `<@U123|name>`, generic `@name`) before matching.
 * Only the leading run is removed, so natural-language text is unaffected.
 */
function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*(?:<@[!#]?[A-Za-z0-9_]+(?:\|[^>]+)?>|@\S+))+\s*/, '');
}

/**
 * True when the message's leading token is the explicit command (slash command
 * or skill name), ignoring any leading @mention of the bot. Exact match only —
 * natural-language requests are guided to this command by the deshi delegation
 * fragment, not matched here.
 */
export function matchesScopeCommand(content: string): boolean {
  const text = stripLeadingMentions(parseText(content));
  if (!text) return false;
  return COMMAND_ALIASES.has(text.split(/\s/)[0].toLowerCase());
}

// Reply to the request channel via the delivery adapter directly (same path as
// the scope-link DM). Not `writeOutboundDirect` — that opens outbound.db
// read-only and throws "attempt to write a readonly database"
// (see src/deshi/inbound/skill-execution-notifications.ts).
async function reply(input: KnowledgeScopeCommandInput, text: string): Promise<void> {
  const { channelType, platformId, threadId } = input.deliveryAddr;
  const adapter = getDeliveryAdapter();
  if (!adapter || !channelType || !platformId) return;
  try {
    await adapter.deliver(channelType, platformId, threadId, 'chat-sdk', JSON.stringify({ text }));
  } catch (err) {
    log.error('Knowledge-scope command reply failed', { agentGroupId: input.agentGroupId, err });
  }
}

/** Requester-facing message for a non-ok scope-link result (owner-self path). */
function scopeFailureText(reason: Exclude<ScopeLinkResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'not-deshi':
      return 'このチャンネルは知識スコープ編集に対応していません（deshi 連携グループ専用）。';
    case 'no-dm':
      return 'DM 宛先が見つかりませんでした。一度ボットに DM を送ってから再度お試しください。';
    default:
      return 'リンクの生成に失敗しました。時間をおいて再度お試しください。';
  }
}

/**
 * Non-owner (or unidentifiable sender): forward the request to the owner's DM
 * with context (which channel, who asked) and the edit link. The link is
 * NEVER sent to the request channel — anyone who opens it can edit the scope,
 * so it must stay in the owner's DM.
 */
async function forwardToOwner(input: KnowledgeScopeCommandInput): Promise<void> {
  const owner = pickApprover(input.agentGroupId)[0];
  if (!owner) {
    log.warn('Knowledge-scope command — no owner/admin to forward to', { agentGroupId: input.agentGroupId });
    await reply(input, 'このグループには管理者が設定されていないため、リクエストを転送できませんでした。');
    return;
  }

  const channel = getMessagingGroup(input.messagingGroupId);
  const channelLabel = channelSource(channel);
  // Prefer the display name (LINE attaches one) and keep the id in parens so
  // the owner can act unambiguously; fall back to the raw id when no name.
  const senderName = parseSenderName(input.content);
  const who = senderName ? `${senderName}さん（${input.userId ?? 'ID不明'}）` : (input.userId ?? '不明な送信者');
  const preamble =
    `🔔 「${channelLabel}」で ${who} が知識スコープの編集をリクエストしました。\n` +
    `問題なければ下記リンクから設定してください（10分有効・1回限り）:`;

  const result = await maybeDeliverScopeLink(input.agentGroupId, input.messagingGroupId, owner, preamble);
  log.info('Knowledge-scope request forwarded to owner', {
    agentGroupId: input.agentGroupId,
    requester: input.userId,
    owner,
    ok: result.ok,
  });

  if (result.ok) {
    await reply(input, 'リクエストをオーナーに転送しました。設定をお待ちください。');
  } else if (result.reason === 'not-deshi') {
    await reply(input, 'このチャンネルは知識スコープ編集に対応していません（deshi 連携グループ専用）。');
  } else {
    await reply(input, 'オーナーへの転送に失敗しました。時間をおいて再度お試しください。');
  }
}

/**
 * Handle `/update-knowledge-scope`. Returns true when the message was this
 * command (and has been answered) so the router stops processing it; false
 * otherwise so normal routing continues.
 */
export async function handleKnowledgeScopeCommand(input: KnowledgeScopeCommandInput): Promise<boolean> {
  if (!matchesScopeCommand(input.content)) return false;

  // Owner/admin: DM the edit link to themselves.
  if (input.userId && hasAdminPrivilege(input.userId, input.agentGroupId)) {
    const result = await maybeDeliverScopeLink(input.agentGroupId, input.messagingGroupId, input.userId);
    if (result.ok) {
      await reply(
        input,
        '📩 知識の編集リンクを DM または管理者用チャンネルに送りました（10分有効・1回限り）。ご確認ください。',
      );
    } else {
      await reply(input, scopeFailureText(result.reason));
    }
    return true;
  }

  // Non-owner / unidentifiable: forward to the owner (never link in-channel).
  await forwardToOwner(input);
  return true;
}
