/**
 * Knowledge-scope onboarding link (isbtty/deshi#396, Slice 5 — nanoclaw side).
 *
 * When the owner wires a newly-registered channel to a deshi-backed agent
 * group, we DM them a signed one-time link that opens deshi's scope-selection
 * page for this channel. The owner picks which wiki subtrees the channel may
 * see; deshi persists the choice and enforces it on `/deshi-general` via the
 * scoped knowledge MCP. nanoclaw is a thin relay here — it only mints the link
 * (`POST /knowledge/scope-link`) and forwards the URL.
 *
 * Gated on the wired agent group actually using the `deshi` MCP server: a
 * non-deshi group has no scoped-knowledge layer, so the link would be
 * meaningless. Brand-new agent groups (create-new-agent flow) have no deshi
 * server by default and are skipped naturally.
 *
 * Best-effort: any failure (no deshi, daemon down, no approver DM) is logged
 * and swallowed so it never blocks wiring or the message replay.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { fetchDeshiScopeLink } from '../../deshi/fetch-scope-link.js';
import { log } from '../../log.js';
import { ensureUserDm } from './user-dm.js';

/** True when the agent group's container config wires the `deshi` MCP server. */
function usesDeshiMcp(agentGroupId: string): boolean {
  const row = getContainerConfig(agentGroupId);
  if (!row?.mcp_servers) return false;
  try {
    const servers = JSON.parse(row.mcp_servers) as Record<string, unknown>;
    return Boolean(servers.deshi);
  } catch {
    return false;
  }
}

/**
 * DM the approver a scope-setup link for the just-wired channel. No-op
 * (logged) when the agent group isn't deshi-backed, the messaging group is
 * gone, the daemon call fails, or the approver has no reachable DM.
 */
export async function maybeDeliverScopeLink(
  agentGroupId: string,
  messagingGroupId: string,
  approverUserId: string,
): Promise<void> {
  if (!usesDeshiMcp(agentGroupId)) {
    log.debug('Scope-link skipped — agent group does not use the deshi MCP server', { agentGroupId });
    return;
  }

  const mg = getMessagingGroup(messagingGroupId);
  if (!mg) {
    log.warn('Scope-link skipped — messaging group not found', { messagingGroupId });
    return;
  }
  // The deshi scope store keys on `channelContext.platformId` as-is
  // (isbtty/deshi#420), which the container reads from
  // `session_routing.platform_id` == `mg.platform_id`. For chat-SDK adapters
  // `platform_id` is already channel-namespaced (`telegram:<id>`), so use it
  // verbatim — prefixing `channel_type` again would double it
  // (`telegram:telegram:<id>`) and miss the key (deny-by-default). Must land
  // paired with isbtty/deshi#420.
  const channelId = mg.platform_id;

  try {
    const { url } = await fetchDeshiScopeLink(channelId);

    const approverDm = await ensureUserDm(approverUserId);
    if (!approverDm) {
      log.warn('Scope-link minted but approver has no DM channel', { approverUserId, channelId });
      return;
    }
    const adapter = getDeliveryAdapter();
    if (!adapter) return;

    // The scope-link token is base64url; its `_` chars collide with Telegram's
    // legacy-Markdown italic rule (`sanitizeTelegramLegacyMarkdown`), which is
    // character-based — a backslash escape (`\_`) wouldn't help — and silently
    // strips them, corrupting the token. Percent-encode `_` to `%5F` so the
    // sent text carries no literal `_`: the sanitizer leaves the URL untouched,
    // it stays a bare auto-linkable (tap-to-open) URL on every channel, and the
    // daemon's query parser decodes `%5F` back to `_` before verifying. `-` (the
    // other base64url special) is never touched by the sanitizer, so it's left
    // as-is; the URL prefix (`…/scope-ui?token=`) contains no `_`, so only the
    // token's underscores are rewritten.
    const linkUrl = url.replaceAll('_', '%5F');

    await adapter.deliver(
      approverDm.channel_type,
      approverDm.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        text: `📚 このチャンネルで公開する知識を選んでください（10分有効・1回限り）。下のリンクを開いてください:\n${linkUrl}`,
      }),
    );
    log.info('Scope-link delivered to approver', { messagingGroupId, agentGroupId, channelId });
  } catch (err) {
    log.error('Scope-link delivery failed', { messagingGroupId, agentGroupId, channelId, err });
  }
}
