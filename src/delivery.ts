/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';

import { getRunningSessions, getActiveSessions, createPendingQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
  type OutboundMessage,
} from './db/session-db.js';
import { log } from './log.js';
import { isCorruptionError, noteOutboundCorruption, noteOutboundReadOk } from './outbound-corruption.js';
import { normalizeOptions } from './channels/ask-question.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles } from './session-manager.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import type { OutboundFile } from './channels/adapter.js';
import type { Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;

// Delivery treats the channel as inherently flaky (Telegram drops connections
// constantly — see isbtty/deshi#491). Transient failures are NOT capped by an
// attempt count; they retry with exponential backoff until they succeed. The
// only bound is a durable time ceiling so a channel that is broken for hours
// eventually dead-letters instead of retrying forever. Permanent failures
// (auth/permission/validation/unauthorized/malformed) skip retries entirely.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
const TRANSIENT_CEILING_MS = 6 * 60 * 60 * 1000; // 6h

/** Delivery errors that will never succeed on retry — dead-lettered on first
 *  occurrence instead of retried. Thrown by deliverMessage for routing/permission
 *  failures; adapter-level permanent errors are matched by name (see isPermanentError). */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}

/** Adapter error `name`s that are permanent. Matched by string so core stays
 *  decoupled from @chat-adapter/* (the adapter sets these names explicitly). */
const PERMANENT_ADAPTER_ERROR_NAMES = new Set([
  'AuthenticationError',
  'PermissionError',
  'ResourceNotFoundError',
  'ValidationError',
  'NotImplementedError',
]);

/** Classify a delivery failure. Default is transient (retry) — only known
 *  permanent errors dead-letter, so an unrecognized error is retried rather
 *  than silently dropped (denylist-permanent). */
function isPermanentError(err: unknown): boolean {
  if (err instanceof PermanentDeliveryError) return true;
  if (err instanceof SyntaxError) return true; // malformed message content (JSON.parse)
  const name = (err as { name?: string } | null)?.name ?? '';
  return PERMANENT_ADAPTER_ERROR_NAMES.has(name);
}

/** Parse a messages_out.timestamp as milliseconds. SQLite `datetime('now')`
 *  yields "YYYY-MM-DD HH:MM:SS" in UTC with no timezone marker, which Date.parse
 *  would misread as local time — normalize to UTC so the ceiling age is correct
 *  regardless of the host timezone. ISO-8601 values with a Z/offset pass through. */
function parseDbTimestampMs(ts: string): number {
  const trimmed = ts.trim();
  const hasTz = /(Z|[+-]\d\d:?\d\d)$/.test(trimmed);
  const isoish = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  return Date.parse(hasTz ? isoish : `${isoish}Z`);
}

/** Backoff before the next retry of a transient failure. Exponential 1s→60s,
 *  but never shorter than a rate-limit's server-provided retryAfter. */
function backoffMs(attempts: number, err: unknown): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
  const retryAfter = (err as { retryAfter?: number } | null)?.retryAfter;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return Math.min(Math.max(exp, retryAfter * 1000), 300_000);
  }
  return exp;
}

/** Per-message retry state. In-memory: resets on process restart, which gives
 *  undelivered transient messages a fresh retry (they survive in messages_out
 *  because no permanent sentinel was written). Permanent failures are already
 *  dead-lettered in the DB, so a restart does not resurrect them. */
const deliveryAttempts = new Map<string, { attempts: number; nextRetryAt: number }>();

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
    /** Delivering adapter instance (defaults to channelType downstream).
     *  Host-internal only — containers never see instance. */
    instance?: string,
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      // Per-session catch: one broken session (e.g. a corrupt outbound.db)
      // must not starve delivery for every session after it in the list.
      try {
        await deliverSessionMessages(session);
      } catch (err) {
        log.error('Active delivery poll error for session', { sessionId: session.id, err });
      }
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      try {
        await deliverSessionMessages(session);
      } catch (err) {
        log.error('Sweep delivery poll error for session', { sessionId: session.id, err });
      }
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch (err) {
    // Usually the DB doesn't exist yet — but SQLITE_NOTADB here means a
    // torn header, which the self-heal must see.
    if (isCorruptionError(err)) noteOutboundCorruption(session, err);
    return;
  }
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    outDb.close();
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    let allDue: OutboundMessage[];
    try {
      allDue = getDueOutboundMessages(outDb);
    } catch (err) {
      // Persistent corruption here (container hard-killed mid-write) would
      // otherwise fail every poll forever — route it to the quarantine
      // streak counter instead of rethrowing.
      if (isCorruptionError(err)) {
        noteOutboundCorruption(session, err);
        return;
      }
      throw err;
    }
    noteOutboundReadOk(session.id);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    const nowMs = Date.now();
    for (const msg of undelivered) {
      // Respect backoff: a transient failure schedules its next attempt, and
      // we skip the message until then. It stays undelivered, so the next poll
      // tick re-drains it once the backoff has elapsed.
      const state = deliveryAttempts.get(msg.id);
      if (state && state.nextRetryAt > nowMs) continue;

      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        handleDeliveryFailure(inDb, session, msg, err);
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

/**
 * Decide what to do with a failed delivery: dead-letter permanent failures
 * immediately, retry transient ones with backoff until a durable time ceiling.
 */
function handleDeliveryFailure(inDb: Database.Database, session: Session, msg: OutboundMessage, err: unknown): void {
  // Permanent — will never succeed on retry. Dead-letter on first occurrence.
  if (isPermanentError(err)) {
    deadLetterMessage(inDb, session, msg, err, 'permanent');
    return;
  }

  // Transient — keep retrying with backoff. The only bound is a durable time
  // ceiling measured from the message's original timestamp, so a channel that
  // stays broken for hours eventually dead-letters instead of retrying forever.
  const ageMs = Date.now() - parseDbTimestampMs(msg.timestamp);
  if (Number.isFinite(ageMs) && ageMs > TRANSIENT_CEILING_MS) {
    deadLetterMessage(inDb, session, msg, err, 'ceiling');
    return;
  }

  const attempts = (deliveryAttempts.get(msg.id)?.attempts ?? 0) + 1;
  const wait = backoffMs(attempts, err);
  deliveryAttempts.set(msg.id, { attempts, nextRetryAt: Date.now() + wait });
  log.warn('Message delivery failed, will retry', {
    messageId: msg.id,
    sessionId: session.id,
    attempt: attempts,
    retryInMs: wait,
    err,
  });
}

/**
 * Terminate delivery of a message: record the permanent-failure sentinel so it
 * is never re-attempted, and drop its retry state.
 *
 * @param reason 'permanent' (deterministic error) or 'ceiling' (transient error
 *   that never recovered within TRANSIENT_CEILING_MS).
 *
 * Seam for 段2 (isbtty/deshi#491, delivery-failure notification): this is where
 * the owner is alerted and the waiting user gets a best-effort apology.
 * NOTE: that notification will reuse the approval-card routing (requestApproval
 * → owner/admin DM). If a future requirement moves approval cards to a separate
 * channel (e.g. a Slack channel for team-operated bots), split the failure/alert
 * routing out into its own logic — where an error alert is delivered is a
 * different concern from where an approval card is delivered.
 */
function deadLetterMessage(
  inDb: Database.Database,
  session: Session,
  msg: OutboundMessage,
  err: unknown,
  reason: 'permanent' | 'ceiling',
): void {
  log.error('Message delivery dead-lettered', {
    messageId: msg.id,
    sessionId: session.id,
    reason,
    err,
  });
  markDeliveryFailed(inDb, msg.id);
  deliveryAttempts.delete(msg.id);
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channel_type === 'agent') {
    if (!hasTable(getDb(), 'agent_destinations')) {
      throw new PermanentDeliveryError(`agent-to-agent module not installed — cannot route message ${msg.id}`);
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage(msg, session);
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  let deliverInstance: string | undefined;
  if (msg.channel_type && msg.platform_id) {
    // Resolve the messaging group ORIGIN-SESSION-FIRST: when the message
    // targets the session's own chat address, the origin row wins even if
    // sibling instances share the same (channel_type, platform_id) — so the
    // reply goes out through the instance the message came in on. Otherwise
    // fall back to the by-platform lookup (default-instance-first).
    const originMg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      originMg && originMg.channel_type === msg.channel_type && originMg.platform_id === msg.platform_id
        ? originMg
        : getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      throw new PermanentDeliveryError(
        `unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`,
      );
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && hasTable(getDb(), 'agent_destinations')) {
      const row = getDb()
        .prepare(
          'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        )
        .get(session.agent_group_id, 'channel', mg.id);
      if (!row) {
        throw new PermanentDeliveryError(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
        );
      }
    }
    deliverInstance = mg.instance;
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'pending_questions')) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
    deliverInstance,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  clearOutbox(session.agent_group_id, session.id, msg.id);

  return platformMsgId;
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Core checks the registry first in
 * `handleSystemAction` and falls through to the inline switch when no
 * handler is registered. The switch will shrink as modules are extracted
 * (scheduling, approvals, agent-to-agent) and eventually only its default
 * branch remains.
 *
 * Default when no handler registered and the switch doesn't match: log
 * "Unknown system action" and return.
 */
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<void>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
}

/** Look up a registered delivery-action handler. Lets module registrations be behavior-tested. */
export function getDeliveryAction(action: string): DeliveryActionHandler | undefined {
  return actionHandlers.get(action);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = actionHandlers.get(action);
  if (registered) {
    await registered(content, session, inDb);
    return;
  }

  log.warn('Unknown system action', { action });
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
