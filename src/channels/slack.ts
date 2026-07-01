/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { createAdapterLogger } from './adapter-logger.js';

/** Slack mrkdwn → markdown: keep URLs (the whole point), unwrap entity tokens. */
function slackMrkdwnToMarkdown(s: string): string {
  return s
    .replace(/<(https?:\/\/[^|<>]+)\|([^<>]+)>/g, '[$2]($1)') // <url|label> → [label](url)
    .replace(/<(https?:\/\/[^<>]+)>/g, '$1') // <url> → url
    .replace(/<@[A-Z0-9_]+\|([^<>]+)>/g, '@$1')
    .replace(/<#[A-Z0-9_]+\|([^<>]+)>/g, '#$1')
    .replace(/<!date\^(\d+)\^[^|>]*(?:\|[^>]*)?>/g, (_m, ts) => new Date(Number(ts) * 1000).toISOString())
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Fetch a thread's root message via conversations.replies. Used when a reply
 * triggers the bot but the root (often the Notion notification carrying the
 * URL/fields) is not in the session. Returns the raw Slack message or null.
 */
async function fetchSlackThreadRoot(
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = (await fetch(
      `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=1&inclusive=true`,
      { headers: { Authorization: `Bearer ${botToken}` } },
    ).then((r) => r.json())) as { ok?: boolean; messages?: Array<Record<string, unknown>> };
    if (!res?.ok || !res.messages?.length) return null;
    return res.messages[0];
  } catch {
    return null;
  }
}

/**
 * Download a Slack file's bytes with the bot token, resolving `url_private`
 * via files.info when the raw file object doesn't carry it (file_share events
 * with file_access:"check_file_info"). Requires the files:read scope. Returns
 * the bytes plus best-known name/mimeType, or null when it can't be fetched.
 *
 * Shared by `resolveAttachmentData` (files on the message itself) and
 * `enrichInboundAttachments` (files pulled from the thread root).
 */
async function resolveSlackFileBytes(
  botToken: string,
  rawFile: Record<string, unknown>,
): Promise<{ data: Buffer; name?: string; mimeType?: string } | null> {
  const id = typeof rawFile.id === 'string' ? rawFile.id : undefined;
  let url = typeof rawFile.url_private === 'string' ? rawFile.url_private : undefined;
  let name = typeof rawFile.name === 'string' ? rawFile.name : undefined;
  let mimeType = typeof rawFile.mimetype === 'string' ? rawFile.mimetype : undefined;
  if (!url && id) {
    const info = (await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    }).then((r) => r.json())) as { ok?: boolean; file?: Record<string, unknown> };
    if (info?.ok && info.file) {
      url = typeof info.file.url_private === 'string' ? info.file.url_private : url;
      name = name ?? (typeof info.file.name === 'string' ? info.file.name : undefined);
      mimeType = mimeType ?? (typeof info.file.mimetype === 'string' ? info.file.mimetype : undefined);
    }
  }
  if (!url) return null;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
  if (!resp.ok) return null;
  const data = Buffer.from(await resp.arrayBuffer());
  return { data, name, mimeType };
}

/**
 * Flatten a Slack Block Kit message into plain markdown text. The adapter's
 * `text` is only a one-line fallback summary for block messages (Notion /
 * automation notifications), so the Notion page URL ("Open in Notion" button)
 * and the inquiry field values are otherwise lost. Returns null when there are
 * no blocks (regular messages — keep the adapter's text untouched).
 */
function flattenSlackBlocks(raw: Record<string, unknown>): string | null {
  const blocks = raw?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const lines: string[] = [];
  for (const b of blocks as Array<Record<string, any>>) {
    if (b?.type === 'section') {
      if (b.text?.text) lines.push(slackMrkdwnToMarkdown(b.text.text));
      for (const f of b.fields ?? []) if (f?.text) lines.push(slackMrkdwnToMarkdown(f.text));
    } else if (b?.type === 'context') {
      for (const el of b.elements ?? [])
        if (el?.type === 'mrkdwn' && el.text) lines.push(slackMrkdwnToMarkdown(el.text));
    } else if (b?.type === 'actions') {
      for (const el of b.elements ?? [])
        if (typeof el?.url === 'string') lines.push(`[${el.text?.text ?? 'link'}](${el.url})`);
    }
  }
  const out = lines.filter((l) => l.trim()).join('\n');
  return out.length > 0 ? out : null;
}

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
      logger: createAdapterLogger('slack'),
    });
    const botToken = env.SLACK_BOT_TOKEN;
    const bridge = createChatSdkBridge({
      adapter: slackAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      // Slack now delivers file_share events with file_access:"check_file_info"
      // and no url_private — the adapter can't build a fetchData(). Resolve the
      // bytes ourselves: files.info to get url_private, then download with the
      // bot token (requires the files:read scope).
      resolveAttachmentData: (rawFile) => resolveSlackFileBytes(botToken, rawFile),
      // Block Kit messages (Notion/automation notifications) carry their URLs
      // and field values in `blocks`, not the plain `text` summary. Flatten the
      // blocks so the agent receives the Notion page URL + inquiry content.
      //
      // Two cases:
      //  1. The message itself carries blocks (a fresh Notion post triggers the
      //     bot) — flatten its own blocks.
      //  2. The message is a thread reply (a user replies to an existing Notion
      //     post asking to investigate) — the root post is not in this session,
      //     so fetch it via conversations.replies and flatten its blocks.
      enrichInboundText: async (raw, currentText) => {
        const own = flattenSlackBlocks(raw);
        if (own) return currentText.trim() ? `${currentText}\n\n${own}` : own;

        const threadTs = typeof raw.thread_ts === 'string' ? raw.thread_ts : undefined;
        const ts = typeof raw.ts === 'string' ? raw.ts : undefined;
        const channel = typeof raw.channel === 'string' ? raw.channel : undefined;
        if (!threadTs || !ts || threadTs === ts || !channel) return null;

        const root = await fetchSlackThreadRoot(botToken, channel, threadTs);
        const rootFlat = root ? flattenSlackBlocks(root) : null;
        if (!rootFlat) return null;
        const base = currentText.trim() ? `${currentText}\n\n` : '';
        return `${base}[スレッド元投稿]\n${rootFlat}`;
      },
      // A thread reply that references an earlier upload carries no files of its
      // own — the bytes live in the thread root (e.g. one bot posts a document,
      // then a reply asks a second bot to read it). The container has no Slack
      // credentials, so it can't fetch by id. Mirror enrichInboundText's
      // thread-root fetch, but for bytes: pull the root's files and hand them
      // over as attachments so the document travels with the message.
      //
      // Only the root message is scanned (limit=1, matching enrichInboundText).
      // A file attached to a non-root reply is not picked up.
      enrichInboundAttachments: async (raw, existing) => {
        if (existing.length > 0) return null; // message brought its own files
        const threadTs = typeof raw.thread_ts === 'string' ? raw.thread_ts : undefined;
        const ts = typeof raw.ts === 'string' ? raw.ts : undefined;
        const channel = typeof raw.channel === 'string' ? raw.channel : undefined;
        if (!threadTs || !ts || threadTs === ts || !channel) return null;

        const root = await fetchSlackThreadRoot(botToken, channel, threadTs);
        const files = root && Array.isArray(root.files) ? (root.files as Array<Record<string, unknown>>) : [];
        if (files.length === 0) return null;

        const out: Array<{ data: Buffer; name?: string; mimeType?: string }> = [];
        for (const f of files) {
          const bytes = await resolveSlackFileBytes(botToken, f);
          if (bytes) out.push(bytes);
        }
        return out.length > 0 ? out : null;
      },
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
});
