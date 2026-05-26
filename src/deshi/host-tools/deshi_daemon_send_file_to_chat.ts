/**
 * Handler: agent から「ホスト上の deshi-raw / deshi-wiki 配下のファイルを、
 * 今いる Telegram (or 他 channel) チャットに送って」と依頼する経路。
 *
 * HTTP path : POST /tools/deshi_daemon_send_file_to_chat
 * agent tool: mcp__deshi__daemon_send_file_to_chat
 *
 * これまで agent は `daemon_search_files` で path を取得できても、host fs に
 * 直接アクセスできないため発見した HTML / PDF を返信に乗せる手段がなかった。
 * その結果「Telegram で直接送ってもらうのが早いです」のような諦めの応答が
 * 出ていた。本 host-tool はそのギャップを埋める:
 *
 *   1. agent が `send_host_file({path, text?})` を呼ぶ (MCP 側で
 *      channelContext を session_routing から自動 inject)
 *   2. 本 handler は deshi daemon の `GET /files/content` でファイルを取得
 *      (utf-8 / base64 のどちらでも返ってくるので base64 に正規化)
 *   3. 既存の `skillExecutionNotificationsHandler` を **in-process で再利用**
 *      して { channel, chatId, threadId, message, files: [{filename, base64}] }
 *      を組み立てて渡す。outbox 配置 + messages_out / messages_in 書き込み +
 *      delivery polling は全部既存パスがやってくれる。
 *
 * 認証: deshi daemon の `/files/content` は authed なので Bearer 必須。
 *
 * 安全策: path は deshi daemon 側で dataDir を起点に解決されるため、
 * ホスト全体への path traversal は daemon 内の `safePath` で弾かれる。
 * 本 host-tool では path の前段検査をしない (二重に書くと daemon との
 * 規約食い違いが起きる)。
 */

import { skillExecutionNotificationsHandler } from '../inbound/skill-execution-notifications.js';

export interface DaemonSendFileToChatRequest {
  /** Path relative to deshi dataDir (= `daemon_search_files` の results[].path と同形式)。 */
  path: string;
  /** Optional text body (= ファイルに添える 1 行コメント)。empty にしてファイルだけ送る用法も OK。 */
  text?: string;
  /** Display filename override. 未指定なら basename(path) を使う。 */
  filename?: string;
  /**
   * Channel routing — MCP stdio が session_routing から auto-inject する。
   * agent からはあえて受け取らない (fabricate されると別チャットに誤送信)。
   */
  channelContext: {
    channel: string;
    platformId: string;
    threadId?: string;
  };
}

export interface DaemonSendFileToChatResponse {
  ok: true;
  /** 配信に使った session の id (debug 用)。 */
  sessionId: string;
  /** outbox / messages_out に書き込んだ messageId (debug 用)。 */
  messageId: string;
  /** Telegram 等に届く表示ファイル名。 */
  filename: string;
}

export async function daemonSendFileToChatHandler(body: unknown): Promise<DaemonSendFileToChatResponse> {
  const req = validateRequest(body);

  const deshiUrl = process.env.DESHI_DAEMON_URL ?? 'http://localhost:3100';
  const secret = process.env.DESHI_DAEMON_DEVICE_SECRET;
  if (!secret) {
    throw new Error('DESHI_DAEMON_DEVICE_SECRET is not set on host-tools-server');
  }

  // 1. deshi daemon の `/files/content` から本体を取得 (utf-8 or base64)。
  //    encodeURIComponent でフルパス分を encode するが daemon 側は `safePath`
  //    で dataDir 起点に解決するので path traversal は弾かれる前提。
  const fileUrl = `${deshiUrl}/files/content?path=${encodeURIComponent(req.path)}`;
  const fileRes = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${secret}:nanoclaw` },
  });
  if (!fileRes.ok) {
    const text = await fileRes.text();
    throw new Error(`deshi daemon /files/content failed: ${fileRes.status} ${text}`);
  }
  const fileData = (await fileRes.json()) as {
    name?: string;
    extension?: string;
    encoding?: 'utf-8' | 'base64';
    content?: string;
  };
  if (
    typeof fileData.name !== 'string' ||
    typeof fileData.content !== 'string' ||
    (fileData.encoding !== 'utf-8' && fileData.encoding !== 'base64')
  ) {
    throw new Error(`deshi daemon /files/content returned unexpected body: ${JSON.stringify(fileData).slice(0, 200)}`);
  }

  // 2. base64 に正規化。daemon が text モードで返した場合 (`encoding: 'utf-8'`)
  //    は Buffer.from(...).toString('base64') で encode し直す。
  const contentBase64 =
    fileData.encoding === 'base64' ? fileData.content : Buffer.from(fileData.content, 'utf-8').toString('base64');

  const filename = req.filename ?? fileData.name;

  // 3. 既存の skillExecutionNotificationsHandler を再利用。in-process 呼出なので
  //    HTTP / auth 往復は不要。Telegram への配信は host の delivery polling が
  //    既存パスで処理する。
  const result = await skillExecutionNotificationsHandler({
    channel: req.channelContext.channel,
    chatId: req.channelContext.platformId,
    threadId: req.channelContext.threadId ?? null,
    message: req.text ?? '',
    files: [{ filename, contentBase64 }],
  });

  return {
    ok: true,
    sessionId: result.sessionId,
    messageId: result.messageId,
    filename,
  };
}

function validateRequest(body: unknown): DaemonSendFileToChatRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('request body must be a JSON object');
  }
  const r = body as Record<string, unknown>;

  if (typeof r.path !== 'string' || r.path.length === 0) {
    throw new Error('path is required (relative to deshi dataDir, e.g. "outputs/2026-05-26-foo/bar.html")');
  }

  let text: string | undefined;
  if (r.text !== undefined && r.text !== null) {
    if (typeof r.text !== 'string') {
      throw new Error('text must be a string');
    }
    text = r.text;
  }

  let filename: string | undefined;
  if (r.filename !== undefined && r.filename !== null) {
    if (typeof r.filename !== 'string' || r.filename.length === 0) {
      throw new Error('filename must be a non-empty string');
    }
    filename = r.filename;
  }

  // channelContext は MCP stdio が auto-inject する想定。agent が直接渡すと
  // fabricate の余地が出るが、host-tools-server 単体テスト用に passthrough は許容。
  if (typeof r.channelContext !== 'object' || r.channelContext === null) {
    throw new Error('channelContext is required (MCP stdio injects this from session_routing)');
  }
  const cc = r.channelContext as Record<string, unknown>;
  if (typeof cc.channel !== 'string' || cc.channel.length === 0) {
    throw new Error('channelContext.channel is required');
  }
  if (typeof cc.platformId !== 'string' || cc.platformId.length === 0) {
    throw new Error('channelContext.platformId is required');
  }
  let threadId: string | undefined;
  if (cc.threadId !== undefined && cc.threadId !== null) {
    if (typeof cc.threadId !== 'string') {
      throw new Error('channelContext.threadId must be a string');
    }
    threadId = cc.threadId;
  }

  return {
    path: r.path,
    text,
    filename,
    channelContext: { channel: cc.channel, platformId: cc.platformId, threadId },
  };
}
