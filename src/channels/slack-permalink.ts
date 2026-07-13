/**
 * Slack archive permalink → inline thread text.
 *
 * When a user sends the bot a Slack permalink (e.g. "このエラー何？
 * https://ws.slack.com/archives/C…/p1783…"), the referenced thread lives behind
 * the Slack API. The bot delegates investigation to deshi, which runs in a
 * separate credential context with no Slack token — so a bare link is dead on
 * arrival (deshi's fetch returns `not_authed`). The bot token lives here in
 * nanoclaw, so we resolve the linked thread's messages up front and append them
 * to the inbound text before it travels to the agent / deshi.
 *
 * Wired via the bridge's `enrichInboundText` hook (see slack.ts).
 */

/** A resolved thread message, as returned by the adapter's `fetchMessages`. */
export interface ThreadMessage {
  /** Slack message ts (also the message id) — used to order/filter by time. */
  id?: string;
  text?: string;
  author?: { userName?: string; fullName?: string };
  /** Raw Slack event — carries Block Kit content the adapter drops from `text`. */
  raw?: unknown;
}

/** Minimal slice of the Slack adapter this resolver needs. */
export interface ThreadFetcher {
  fetchMessages(
    threadId: string,
    options?: { direction?: 'forward' | 'backward'; limit?: number },
  ): Promise<{ messages: ThreadMessage[] }>;
}

/**
 * Pull renderable text out of a Slack Block Kit block. Automation/error
 * notifications (the exact case this resolver exists for) put their whole body
 * in `attachments[].blocks[]` and leave the message's plain `text` empty, so
 * without this the linked error would arrive blank.
 */
function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as Record<string, any>;
  const parts: string[] = [];
  if (typeof b.text === 'string') parts.push(b.text);
  else if (b.text && typeof b.text.text === 'string') parts.push(b.text.text);
  for (const el of Array.isArray(b.elements) ? b.elements : []) {
    if (typeof el?.text === 'string') parts.push(el.text);
    for (const sub of Array.isArray(el?.elements) ? el.elements : []) {
      if (typeof sub?.text === 'string') parts.push(sub.text);
    }
  }
  for (const f of Array.isArray(b.fields) ? b.fields : []) {
    if (typeof f?.text === 'string') parts.push(f.text);
  }
  return parts.join('\n');
}

/** Reconstruct message text from a raw Slack event's blocks + attachments. */
function extractRawText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const r = raw as Record<string, any>;
  const parts: string[] = [];
  for (const b of Array.isArray(r.blocks) ? r.blocks : []) parts.push(blockText(b));
  for (const att of Array.isArray(r.attachments) ? r.attachments : []) {
    if (typeof att?.title === 'string') parts.push(att.title);
    const attBlocks = Array.isArray(att?.blocks) ? att.blocks : [];
    for (const b of attBlocks) parts.push(blockText(b));
    if (!attBlocks.length && typeof att?.text === 'string') parts.push(att.text);
    else if (!attBlocks.length && typeof att?.fallback === 'string') parts.push(att.fallback);
  }
  return parts
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
}

/** Best-effort display text for one message: plain text, else Block Kit body. */
function messageBody(msg: ThreadMessage): string {
  const plain = (msg.text ?? '').trim();
  return plain || extractRawText(msg.raw).trim();
}

/** Render `messages` as `who: body` lines, dropping any with no renderable body. */
function formatThreadLines(messages: ThreadMessage[]): string[] {
  return messages
    .map((msg) => {
      const who = msg.author?.userName || msg.author?.fullName || 'unknown';
      const body = messageBody(msg);
      return body ? `${who}: ${body}` : '';
    })
    .filter(Boolean);
}

// `https://<workspace>.slack.com/archives/<CHANNEL>/p<digits>[?query]`
// The `p<digits>` form concatenates a Slack ts (`<seconds>.<microseconds>`),
// so the last 6 digits are the fractional part. A reply permalink carries the
// parent in `?thread_ts=` — we fetch from the parent so the referenced message
// travels with its surrounding thread.
const SLACK_ARCHIVE_LINK_RE = /https?:\/\/[a-z0-9][\w-]*\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)(\?[^\s>)"']*)?/gi;

/** Max messages pulled per linked thread — enough for context, bounded for cost. */
const THREAD_FETCH_LIMIT = 50;

/** Build a `slack:<channel>:<ts>` thread id from a permalink's captured parts. */
export function permalinkToThreadId(channel: string, pDigits: string, query?: string): string {
  const threadTs = query?.match(/[?&]thread_ts=([\d.]+)/)?.[1];
  const ts = threadTs ?? `${pDigits.slice(0, -6)}.${pDigits.slice(-6)}`;
  return `slack:${channel}:${ts}`;
}

/**
 * Find Slack permalinks in `text`, resolve each linked thread via the adapter,
 * and return `text` with the resolved messages appended. Returns null when there
 * is nothing to add (no links, or none resolved) so the caller can keep the
 * original text unchanged. Never throws: a failed fetch is logged and skipped.
 */
export async function resolveSlackPermalinks(
  adapter: ThreadFetcher,
  text: string,
  onError?: (threadId: string, err: unknown) => void,
): Promise<string | null> {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const m of text.matchAll(SLACK_ARCHIVE_LINK_RE)) {
    const [, channel, pDigits, query] = m;
    const threadId = permalinkToThreadId(channel, pDigits, query);
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    try {
      const res = await adapter.fetchMessages(threadId, {
        direction: 'forward',
        limit: THREAD_FETCH_LIMIT,
      });
      const lines = formatThreadLines(res?.messages ?? []);
      if (lines.length) {
        blocks.push(`── リンク先スレッド (${channel}) ──\n${lines.join('\n')}`);
      }
    } catch (err) {
      onError?.(threadId, err);
    }
  }
  return blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : null;
}

/**
 * Fetch the messages that precede `currentMessageTs` in `threadId` and render
 * them as a context block, or null if there are none. Used when the bot is
 * first pulled into an existing thread (a mid-thread mention creates a fresh
 * per-thread session whose container never saw the earlier posts).
 *
 * The prior-only filter makes the trigger self-selecting: a mention at the
 * thread root — or a brand-new top-level message — has nothing before it and
 * yields null, so only a genuine reply-into-history produces a backfill.
 * Never throws: a failed fetch is reported and treated as "no backfill".
 */
export async function resolveThreadBackfill(
  adapter: ThreadFetcher,
  threadId: string,
  currentMessageTs: string,
  onError?: (threadId: string, err: unknown) => void,
): Promise<string | null> {
  let messages: ThreadMessage[];
  try {
    const res = await adapter.fetchMessages(threadId, { direction: 'forward', limit: THREAD_FETCH_LIMIT });
    messages = res?.messages ?? [];
  } catch (err) {
    onError?.(threadId, err);
    return null;
  }
  const current = Number.parseFloat(currentMessageTs);
  const prior = messages.filter((m) => {
    const ts = Number.parseFloat(m.id ?? '');
    return Number.isFinite(ts) && (!Number.isFinite(current) || ts < current);
  });
  const lines = formatThreadLines(prior);
  // Header flags this as system-fetched so the agent doesn't misattribute it as
  // content the user pasted (it's the thread history we pulled in on join).
  return lines.length ? `── このスレッドの先行メッセージ（自動取得） ──\n${lines.join('\n')}` : null;
}
