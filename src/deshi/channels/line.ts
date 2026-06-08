/**
 * LINE Messaging API channel adapter (native, no Chat SDK bridge).
 *
 * 設計判断は isbtty/deshi#259 に準拠:
 *   - native 実装 (@chat-adapter/line は upstream に存在しない)
 *   - supportsThreads = false (LINE に thread 概念なし)
 *   - platformId = `line:user|group|room:{id}` 自己記述形式
 *   - 送信は push API 統一 (reply token 不使用 — 寿命 ~1 分の管理を回避)
 *   - inbound 添付は `api-data.line.me` から DL、base64 で `attachments[].data` に
 *     詰めて router に渡す (session-manager が session inbox に展開する設計)
 *   - DM は無条件 isMention=true (router に attentive 判定させるため)
 */
import crypto from 'crypto';
import http from 'http';

import { ASSISTANT_NAME } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from '../../channels/adapter.js';

const LINE_API_BASE = 'https://api.line.me';
const LINE_DATA_API_BASE = 'https://api-data.line.me';
const LINE_TEXT_LIMIT = 5000;
const DEFAULT_PORT = 10280;
const DEFAULT_PATH = '/webhook';

// --- Types (LINE Messaging API webhook payload subset) ---

interface LineEventSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineContentProvider {
  type: 'line' | 'external';
  originalContentUrl?: string;
  previewImageUrl?: string;
}

interface LineMentionee {
  index: number;
  length: number;
  type?: 'user' | 'all' | string;
  userId?: string;
}

interface LineMention {
  mentionees?: LineMentionee[];
}

interface LineMessage {
  id: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location' | string;
  text?: string;
  fileName?: string;
  contentProvider?: LineContentProvider;
  mention?: LineMention;
}

interface LineBotInfo {
  userId?: string;
  basicId?: string;
  displayName?: string;
}

interface LineEvent {
  type: string; // 'message' | 'follow' | 'join' | 'postback' | ...
  webhookEventId?: string;
  timestamp: number;
  source: LineEventSource;
  replyToken?: string;
  message?: LineMessage;
}

interface LineProfile {
  displayName?: string;
  userId?: string;
}

interface LineGroupSummary {
  groupName?: string;
  groupId?: string;
}

// --- Helpers (exported for tests) ---

export function validateSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function parsePlatformId(platformId: string): { kind: 'user' | 'group' | 'room'; id: string } | null {
  const m = /^line:(user|group|room):(.+)$/.exec(platformId);
  if (!m) return null;
  return { kind: m[1] as 'user' | 'group' | 'room', id: m[2]! };
}

export function platformIdForSource(source: LineEventSource): string | null {
  if (source.type === 'group' && source.groupId) return `line:group:${source.groupId}`;
  if (source.type === 'room' && source.roomId) return `line:room:${source.roomId}`;
  if (source.type === 'user' && source.userId) return `line:user:${source.userId}`;
  return null;
}

export function splitForLineLimit(text: string, limit: number = LINE_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

/**
 * グループ内で bot が mention されたかを判定する。
 *
 * 優先度:
 *   1. event.message.mention.mentionees に `botUserId` 一致 or `type === 'all'` がある (LINE Platform が解析した正式な mention 情報)
 *   2. text に `assistantName` の regex match がある (mention 機能を使わずに名前打ったとき / mention 情報が来ないとき)
 *
 * `botUserId` が未取得 (= /v2/bot/info 失敗等) の場合、優先度 1 の userId 一致は無効化される
 * (type === 'all' は引き続き有効)。優先度 2 は botUserId に依存しない。
 */
export function isBotMentionedInGroup(
  text: string,
  mentionees: Array<{ userId?: string; type?: string }> | undefined,
  botUserId: string | undefined,
  assistantName: string,
): boolean {
  const byMentionee = (mentionees ?? []).some(
    (m) => m.type === 'all' || (botUserId !== undefined && m.userId === botUserId),
  );
  if (byMentionee) return true;
  if (!text) return false;
  return new RegExp(`(?:^|\\W)@?${assistantName}(?:$|\\W)`, 'i').test(text);
}

// --- Adapter factory ---

registerChannelAdapter('line', {
  factory: () => {
    const env = readEnvFile([
      'LINE_CHANNEL_ACCESS_TOKEN',
      'LINE_CHANNEL_SECRET',
      'LINE_WEBHOOK_PORT',
      'LINE_WEBHOOK_PATH',
    ]);
    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || env.LINE_CHANNEL_ACCESS_TOKEN;
    const channelSecret = process.env.LINE_CHANNEL_SECRET || env.LINE_CHANNEL_SECRET;
    if (!accessToken || !channelSecret) return null;

    const port = parseInt(process.env.LINE_WEBHOOK_PORT || env.LINE_WEBHOOK_PORT || `${DEFAULT_PORT}`, 10);
    const webhookPath = process.env.LINE_WEBHOOK_PATH || env.LINE_WEBHOOK_PATH || DEFAULT_PATH;

    let setupConfig: ChannelSetup;
    let server: http.Server | undefined;
    let listening = false;
    let botUserId: string | undefined; // GET /v2/bot/info で取得、グループ mention 判定に使う
    const seenWebhookEventIds = new Set<string>();
    // Bound dedup memory: ~1024 events is plenty given LINE's retry window.
    const DEDUP_MAX = 1024;

    async function lineFetch<T = unknown>(
      method: 'GET' | 'POST',
      url: string,
      body?: unknown,
    ): Promise<{ ok: boolean; status: number; data?: T; text?: string }> {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data: T | undefined;
      try {
        data = text ? (JSON.parse(text) as T) : undefined;
      } catch {
        // non-JSON; leave data undefined
      }
      return { ok: res.ok, status: res.status, data, text };
    }

    async function pushMessage(to: string, text: string): Promise<string | undefined> {
      const res = await lineFetch<{ sentMessages?: Array<{ id?: string }> }>(
        'POST',
        `${LINE_API_BASE}/v2/bot/message/push`,
        { to, messages: [{ type: 'text', text }] },
      );
      if (!res.ok) {
        log.error('LINE push failed', { status: res.status, body: res.text?.slice(0, 500) });
        return undefined;
      }
      return res.data?.sentMessages?.[0]?.id;
    }

    async function fetchUserName(userId: string): Promise<string | undefined> {
      const res = await lineFetch<LineProfile>('GET', `${LINE_API_BASE}/v2/bot/profile/${userId}`);
      return res.ok ? res.data?.displayName : undefined;
    }

    async function fetchGroupName(groupId: string): Promise<string | undefined> {
      const res = await lineFetch<LineGroupSummary>('GET', `${LINE_API_BASE}/v2/bot/group/${groupId}/summary`);
      return res.ok ? res.data?.groupName : undefined;
    }

    async function downloadContent(
      msg: LineMessage,
    ): Promise<{ type: string; name: string; mimeType: string; size: number; data: string } | null> {
      const contentType = msg.type;
      const typeMap: Record<string, { type: string; ext: string; mimeType: string }> = {
        image: { type: 'image', ext: '.jpg', mimeType: 'image/jpeg' },
        video: { type: 'video', ext: '.mp4', mimeType: 'video/mp4' },
        audio: { type: 'audio', ext: '.m4a', mimeType: 'audio/mp4' },
        file: { type: 'document', ext: '', mimeType: 'application/octet-stream' },
      };
      const meta = typeMap[contentType];
      if (!meta) return null;

      let url: string;
      let headers: Record<string, string> | undefined;
      if (msg.contentProvider?.type === 'external' && msg.contentProvider.originalContentUrl) {
        url = msg.contentProvider.originalContentUrl;
      } else {
        url = `${LINE_DATA_API_BASE}/v2/bot/message/${encodeURIComponent(msg.id)}/content`;
        headers = { Authorization: `Bearer ${accessToken}` };
      }

      try {
        const res = await fetch(url, { method: 'GET', headers });
        if (!res.ok) {
          log.warn('LINE content download failed', { status: res.status, messageId: msg.id });
          return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());

        // session-manager が `attachments[].data` (base64) を受け取って
        // `inbox/<messageId>/<filename>` に書き出し、`localPath` をセットする。
        // 我々はディスク書き込みをせず、base64 で渡すだけ。
        const rawFilename = msg.fileName;
        const fallback = `line-${msg.id}${meta.ext}`;
        const name = rawFilename && isSafeAttachmentName(rawFilename) ? rawFilename : fallback;

        return {
          type: meta.type,
          name,
          mimeType: res.headers.get('content-type') ?? meta.mimeType,
          size: buf.length,
          data: buf.toString('base64'),
        };
      } catch (err) {
        log.warn('LINE content download error', { err, messageId: msg.id });
        return null;
      }
    }

    function rememberWebhookEventId(id: string | undefined): boolean {
      if (!id) return false;
      if (seenWebhookEventIds.has(id)) return true;
      seenWebhookEventIds.add(id);
      if (seenWebhookEventIds.size > DEDUP_MAX) {
        // Drop oldest (Set preserves insertion order)
        const first = seenWebhookEventIds.values().next().value;
        if (first) seenWebhookEventIds.delete(first);
      }
      return false;
    }

    async function processEvent(event: LineEvent): Promise<void> {
      log.debug('LINE event received', {
        type: event.type,
        sourceType: event.source.type,
        hasMessage: !!event.message,
        messageType: event.message?.type,
        hasMention: !!event.message?.mention,
      });

      if (rememberWebhookEventId(event.webhookEventId)) {
        log.debug('LINE duplicate webhook event, skipping', { id: event.webhookEventId });
        return;
      }

      const platformId = platformIdForSource(event.source);
      if (!platformId) {
        log.debug('LINE event without resolvable source, skipping', { type: event.type });
        return;
      }

      const isGroup = event.source.type === 'group' || event.source.type === 'room';

      // Best-effort metadata enrichment
      try {
        if (event.source.type === 'group' && event.source.groupId) {
          const name = await fetchGroupName(event.source.groupId);
          if (name) setupConfig.onMetadata(platformId, name, true);
        } else if (event.source.type === 'user' && event.source.userId) {
          const name = await fetchUserName(event.source.userId);
          if (name) setupConfig.onMetadata(platformId, name, false);
        } else if (event.source.type === 'room') {
          // rooms have no summary API; just mark isGroup
          setupConfig.onMetadata(platformId, undefined, true);
        }
      } catch (err) {
        log.debug('LINE metadata enrichment failed', { err });
      }

      if (event.type !== 'message' || !event.message) return;

      const msg = event.message;
      let text = '';
      const attachments: Array<{
        type: string;
        name: string;
        mimeType: string;
        size: number;
        data: string;
      }> = [];

      if (msg.type === 'text') {
        text = msg.text ?? '';
      } else if (msg.type === 'sticker') {
        text = '[Sticker]';
      } else if (msg.type === 'location') {
        text = '[Location]';
      } else if (msg.type === 'image' || msg.type === 'video' || msg.type === 'audio' || msg.type === 'file') {
        const att = await downloadContent(msg);
        if (att) {
          attachments.push(att);
          text = `[${att.type}: ${att.name}]`;
        } else {
          text = `[${msg.type}]`;
        }
      } else {
        text = `[${msg.type}]`;
      }

      const botMentionedInGroup =
        isGroup && isBotMentionedInGroup(text, msg.mention?.mentionees, botUserId, ASSISTANT_NAME);

      if (isGroup) {
        log.info('LINE group message', {
          platformId,
          text: text.slice(0, 100),
          mentionees: msg.mention?.mentionees ?? [],
          botUserId,
          botMentionedInGroup,
        });
      }

      const senderUserId = event.source.userId ?? null;
      let senderName: string | undefined;
      if (senderUserId) {
        try {
          senderName = await fetchUserName(senderUserId);
        } catch {
          // best-effort
        }
      }

      const inbound: InboundMessage = {
        id: msg.id || `line-${Date.now()}`,
        kind: 'chat',
        isGroup,
        isMention: !isGroup || botMentionedInGroup ? true : undefined,
        content: {
          text,
          sender: senderUserId ? `line:user:${senderUserId}` : platformId,
          senderName,
          ...(attachments.length > 0 && { attachments }),
          isGroup,
        },
        timestamp: new Date(event.timestamp).toISOString(),
      };

      await setupConfig.onInbound(platformId, null, inbound);
    }

    async function handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = Buffer.concat(chunks);

      const sig = req.headers['x-line-signature'];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      if (!validateSignature(body, sigStr, channelSecret)) {
        res.writeHead(401);
        res.end('Invalid signature');
        return;
      }

      // Acknowledge first — LINE retries on slow / non-200 responses.
      res.writeHead(200);
      res.end('OK');

      let payload: { events?: LineEvent[] };
      try {
        payload = JSON.parse(body.toString('utf-8')) as { events?: LineEvent[] };
      } catch (err) {
        log.warn('LINE webhook JSON parse failed', { err });
        return;
      }

      for (const event of payload.events ?? []) {
        processEvent(event).catch((err) => {
          log.error('LINE event processing failed', { err, eventType: event.type });
        });
      }
    }

    const adapter: ChannelAdapter = {
      name: 'line',
      channelType: 'line',
      supportsThreads: false,

      async setup(hostConfig: ChannelSetup) {
        setupConfig = hostConfig;

        // bot 自身の userId を取得 (グループ内の mention.mentionees 判定で使う)
        try {
          const res = await lineFetch<LineBotInfo>('GET', `${LINE_API_BASE}/v2/bot/info`);
          if (res.ok && res.data?.userId) {
            botUserId = res.data.userId;
            log.info('LINE bot info loaded', { botUserId, displayName: res.data.displayName });
          } else {
            log.warn('LINE /v2/bot/info failed', { status: res.status });
          }
        } catch (err) {
          log.warn('LINE bot info fetch error', { err });
        }

        server = http.createServer((req, res) => {
          if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
            return;
          }
          if (req.method === 'POST' && req.url === webhookPath) {
            handleWebhook(req, res).catch((err) => {
              log.error('LINE webhook handler crashed', { err });
              if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal Server Error');
              }
            });
            return;
          }
          res.writeHead(404);
          res.end('Not Found');
        });

        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject);
          server!.listen(port, () => {
            listening = true;
            log.info('LINE webhook server listening', { port, path: webhookPath });
            resolve();
          });
        });
      },

      async teardown() {
        if (!server) return;
        await new Promise<void>((resolve) => {
          server!.close(() => {
            listening = false;
            resolve();
          });
        });
      },

      isConnected() {
        return listening;
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        const parsed = parsePlatformId(platformId);
        if (!parsed) {
          log.error('LINE deliver: unparseable platformId', { platformId });
          return undefined;
        }

        const content = message.content as Record<string, unknown>;
        const text = (content?.markdown as string) || (content?.text as string) || '';
        if (!text) return undefined;

        const chunks = splitForLineLimit(text);
        let lastId: string | undefined;
        for (const chunk of chunks) {
          lastId = await pushMessage(parsed.id, chunk);
        }
        return lastId;
      },
    };

    return adapter;
  },
});
