/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import fs from 'fs';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { replaceDestinations, type DestinationRow } from '../../db/session-db.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

/** Reserved local name for the implicit "the conversation this session is in" destination. */
const SELF_DESTINATION_NAME = 'here';

export function writeDestinations(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const rows = getDestinations(agentGroupId);
  const resolved: DestinationRow[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        display_name: mg.name ?? row.local_name,
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        display_name: ag.name,
        type: 'agent',
        channel_type: null,
        platform_id: null,
        agent_group_id: ag.id,
      });
    }
  }

  // Always expose the session's own conversation as a destination (`here`)
  // so the agent can reply to whoever it is currently talking to, even when
  // no named destination was wired for that sender. Without this, a brand-new
  // sender's session inherits only the agent's *other* configured destinations
  // and the agent's reply gets misdelivered to an unrelated party (cross-user
  // leak). Skipped when an admin-wired destination already covers the same
  // conversation (e.g. the owner's own DM) or already claims the `here` name,
  // since `destinations.name` is a primary key.
  const session = getSession(sessionId);
  if (session?.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    const alreadyCovered =
      !mg ||
      resolved.some(
        (r) => r.type === 'channel' && r.channel_type === mg.channel_type && r.platform_id === mg.platform_id,
      ) ||
      resolved.some((r) => r.name === SELF_DESTINATION_NAME);
    if (mg && !alreadyCovered) {
      resolved.push({
        name: SELF_DESTINATION_NAME,
        display_name: mg.name ?? 'this conversation',
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
      });
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    replaceDestinations(db, resolved);
  } finally {
    db.close();
  }
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
