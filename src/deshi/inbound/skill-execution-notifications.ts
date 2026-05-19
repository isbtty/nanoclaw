/**
 * Handler: deshi daemon からの skill 実行結果通知を受け付け、
 * messaging_group に紐づく session の messages_out に書き込んで、
 * 既存の delivery polling loop に乗せて channel adapter に届ける。
 *
 * - HTTP path: POST /inbound/deshi/skill-execution-notifications
 * - 認証: dispatch 側で Bearer <DESHI_DAEMON_DEVICE_SECRET> を一括検証
 * - 命名規則: ADR-0010 (kebab-case、direct HTTP receiver 系統)
 * - 詳細仕様: isbtty/deshi#247 (#issuecomment-4475703497)
 *
 * 設計の要点:
 *
 *   1. delivery を直叩きせず messages_out 経由にする (issue #247 の決定):
 *      agent (container 内 Claude) が「過去に何を言ったか」を覚えているのは
 *      outbound.db の messages_out 経由なので、直接 channel adapter を叩いて
 *      Telegram 投稿しても agent からは「自分が言っていない投稿」になり
 *      会話継続性が壊れる。messages_out に書けば agent も自分の発言として
 *      認識でき、後続の追加質問で文脈を引き継げる。
 *
 *   2. session 解決ロジックは upstream router.ts と一致させる:
 *      ユーザー依頼時の router 経路で作られる session と「同じ session」に
 *      通知を書き込まないと、依頼 session と通知 session が乖離して
 *      上記 (1) の利点を失う。effectiveSessionMode の判定ロジックは
 *      upstream router.ts:410-413 から **コピー** している (ADR-0002 維持の
 *      ため upstream の関数 export には依存しない)。upstream 側で判定が
 *      変わった場合、本コピーを追随する必要がある。
 *
 *   3. adapterSupportsThreads は静的マップで保持 (ADR-0010 §5):
 *      host-tools-server は host 本体と別プロセスで起動するため、
 *      channel adapter registry が空。getChannelAdapter() を呼んでも
 *      undefined が返るので、inbound 側に hard-code した SUPPORTS_THREADS を
 *      参照する。新規 channel が upstream に追加された場合は本マップへの
 *      追加が必要 (CONTRIBUTING / PR レビュー観点で吸収)。
 */

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { getMessagingGroupByPlatform, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { openOutboundDbRw } from '../../db/session-db.js';
import { resolveSession, outboundDbPath, sessionDir } from '../../session-manager.js';
import { InboundHandlerError } from './errors.js';

/**
 * Channel ごとの supportsThreads 値の静的マップ (ADR-0010 §5)。
 *
 * 値は upstream `src/channels/<channel>.ts` 内の `supportsThreads:` と
 * 完全一致させること (2026-05-18 時点で確認済み)。upstream で新規 channel が
 * 追加された / 既存 channel の supportsThreads 値が変わった場合、ここを
 * 追随する責任は deshi 側コミッタが負う。
 *
 * なぜここに hard-code するか:
 *   host-tools-server.ts は host 本体 (`pnpm run dev` / `com.nanoclaw.plist`)
 *   とは別プロセス (`com.isbtty.nanoclaw.host-tools.plist`) で起動するため、
 *   initChannelAdapters() が呼ばれず getChannelAdapter() は常に undefined。
 *   adapter init を host-tools-server 側でも走らせる案は Telegram 等の
 *   bot polling が host 本体と二重に走って実用不可。
 *
 * 未登録 channel が来た場合: `false` フォールバック (per-thread 強制を
 * しない、すなわち wiring の session_mode 通りに振る舞う)。安全側 (= 既存
 * session を引きにいく、見つからなければ shared モードで新規作成)。
 */
const SUPPORTS_THREADS: Record<string, boolean> = {
  // upstream src/channels/discord.ts:35
  discord: true,
  // upstream src/channels/slack.ts:19
  slack: true,
  // upstream src/channels/teams.ts:21
  teams: true,
  // upstream src/channels/linear.ts:43
  linear: true,
  // upstream src/channels/github.ts:21
  github: true,
  // upstream src/channels/webex.ts:19
  webex: true,
  // upstream src/channels/telegram.ts:211
  telegram: false,
  // upstream src/channels/whatsapp.ts:655
  whatsapp: false,
  // upstream src/channels/whatsapp-cloud.ts:27
  'whatsapp-cloud': false,
  // upstream src/channels/imessage.ts:27
  imessage: false,
  // upstream src/channels/matrix.ts:163
  matrix: false,
  // upstream src/channels/resend.ts:21
  resend: false,
  // upstream src/channels/wechat.ts:159
  wechat: false,
  // upstream src/channels/cli.ts:58
  cli: false,
};

export interface SkillExecutionNotificationFile {
  filename: string;
  contentBase64: string;
}

export interface SkillExecutionNotificationRequest {
  channel: string;
  chatId: string;
  threadId?: string | null;
  message: string;
  files?: SkillExecutionNotificationFile[];
}

export interface SkillExecutionNotificationResponse {
  ok: true;
  sessionId: string;
  messageId: string;
}

export async function skillExecutionNotificationsHandler(body: unknown): Promise<SkillExecutionNotificationResponse> {
  const req = validateRequest(body);

  // 1. messaging_group lookup — どの chat への通知か特定
  const mg = getMessagingGroupByPlatform(req.channel, req.chatId);
  if (!mg) {
    throw new InboundHandlerError(404, `messaging_group not found for ${req.channel}/${req.chatId}`);
  }

  // 2. wiring lookup — どの agent_group に紐づくか特定
  //    1 nanoclaw = 1 deshi 前提 (ADR-0010 §5 と issue #247 の想定) のため
  //    agents は 1 件想定。複数 wiring されているケースは現状非対応。
  const agents = getMessagingGroupAgents(mg.id);
  if (agents.length === 0) {
    throw new InboundHandlerError(404, `no agent wired to messaging_group ${mg.id}`);
  }
  const agent = agents[0]!;

  // 3. effectiveSessionMode 計算 (upstream router と同じロジック)
  const adapterSupportsThreads = SUPPORTS_THREADS[req.channel] ?? false;
  const effectiveSessionMode = computeEffectiveSessionMode(agent.session_mode, adapterSupportsThreads, mg.is_group);

  // 4. session ensure
  //    ユーザー依頼時に router 経由で作られた session と同じ session を引く。
  //    存在しない場合は新規作成 (cron task など、 router 経路を通っていない
  //    initial 通知でも動作するように)。
  const { session } = resolveSession(agent.agent_group_id, mg.id, req.threadId ?? null, effectiveSessionMode);

  // 5. attachment 書き込み (`outbox/<message_id>/<filename>`)
  //    message_id は upstream の `isSafeAttachmentName` を通る形式 (basename
  //    安全) で生成する。crypto.randomUUID() は `-` のみで構成されるため OK。
  const messageId = `deshi-inbound-${randomUUID()}`;
  const filenames =
    req.files && req.files.length > 0 ? writeOutboxFiles(agent.agent_group_id, session.id, messageId, req.files) : [];

  // 6. messages_out への INSERT
  //
  // content schema は container 側の send_file / send_message と同じ
  // `{ text, files: string[] }` JSON を採用 (upstream
  // container/agent-runner/src/mcp-tools/core.ts:173)。
  // kind は 'chat' を採用 — system は内部 action 用 (delivery.ts:255)、
  // chat は通常配信のデフォルトで agent からも「自分の発言」として
  // 認識される (会話継続性の維持、issue #247 の決定)。
  // delivery routing は session の messaging_group の (channel_type,
  // platform_id) と (req.threadId | session.thread_id) で決まる。
  //
  // なぜ upstream の `writeOutboundDirect` を使わず自前で SQL を書くか:
  //   upstream の writeOutboundDirect は内部で `openOutboundDb` (readonly)
  //   を呼んでおり、 better-sqlite3 の readonly flag が effective になる
  //   環境 (= テスト環境 / 通常運用) では INSERT が "attempt to write a
  //   readonly database" で fail する。本来 `openOutboundDbRw` を使うべき
  //   実装上のバグ (upstream 由来) で、本 inbound handler では writable
  //   ハンドルで直接書き込む。upstream 修正は本 PR スコープ外。
  //   修正されたら本ブロックを `writeOutboundDirect` 呼び出しに戻して良い。
  writeOutboundMessage({
    agentGroupId: agent.agent_group_id,
    sessionId: session.id,
    id: messageId,
    kind: 'chat',
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: req.threadId ?? session.thread_id ?? null,
    content: JSON.stringify({
      text: req.message,
      files: filenames,
    }),
  });

  return {
    ok: true,
    sessionId: session.id,
    messageId,
  };
}

function validateRequest(body: unknown): SkillExecutionNotificationRequest {
  if (typeof body !== 'object' || body === null) {
    throw new InboundHandlerError(400, 'request body must be a JSON object');
  }
  const r = body as Record<string, unknown>;

  if (typeof r.channel !== 'string' || r.channel.length === 0) {
    throw new InboundHandlerError(400, 'channel is required');
  }
  if (typeof r.chatId !== 'string' || r.chatId.length === 0) {
    throw new InboundHandlerError(400, 'chatId is required');
  }
  if (typeof r.message !== 'string') {
    throw new InboundHandlerError(400, 'message is required');
  }
  if (r.threadId !== undefined && r.threadId !== null && typeof r.threadId !== 'string') {
    throw new InboundHandlerError(400, 'threadId must be string or null');
  }

  let files: SkillExecutionNotificationFile[] | undefined;
  if (r.files !== undefined) {
    if (!Array.isArray(r.files)) {
      throw new InboundHandlerError(400, 'files must be an array');
    }
    files = r.files.map((f, i) => {
      if (typeof f !== 'object' || f === null) {
        throw new InboundHandlerError(400, `files[${i}] must be an object`);
      }
      const fo = f as Record<string, unknown>;
      if (typeof fo.filename !== 'string' || fo.filename.length === 0) {
        throw new InboundHandlerError(400, `files[${i}].filename is required`);
      }
      if (typeof fo.contentBase64 !== 'string') {
        throw new InboundHandlerError(400, `files[${i}].contentBase64 must be a string`);
      }
      return { filename: fo.filename, contentBase64: fo.contentBase64 };
    });
  }

  return {
    channel: r.channel,
    chatId: r.chatId,
    threadId: (r.threadId as string | null | undefined) ?? null,
    message: r.message,
    files,
  };
}

/**
 * effectiveSessionMode の判定 — upstream `src/router.ts:410-413` のロジックを
 * コピー (ADR-0002 維持のため upstream を import しない方針)。
 *
 * 元コード (upstream の router.ts より):
 *   let effectiveSessionMode = agent.session_mode;
 *   if (adapterSupportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
 *     effectiveSessionMode = 'per-thread';
 *   }
 *
 * 意味:
 *   - グループチャット (`is_group !== 0`) かつ adapter が thread をサポートする
 *     場合、wiring の session_mode を上書きして per-thread を強制する
 *   - DM (`is_group === 0`) は thread 概念をまとめて 1 session に倒す
 *   - agent-shared は維持 (channel 横断を意図した directive のため)
 *
 * 追随必要性:
 *   upstream router.ts のこのロジックが変わった場合、本関数も追随する。
 *   router 経路で作られる session と inbound 経由で引く session が乖離すると
 *   会話継続性 (issue #247 で議論済み) が壊れる。
 */
function computeEffectiveSessionMode(
  wiredMode: 'shared' | 'per-thread' | 'agent-shared',
  adapterSupportsThreads: boolean,
  isGroup: number,
): 'shared' | 'per-thread' | 'agent-shared' {
  if (adapterSupportsThreads && wiredMode !== 'agent-shared' && isGroup !== 0) {
    return 'per-thread';
  }
  return wiredMode;
}

/**
 * messages_out への INSERT を host 側 writable handle で実行する。
 *
 * 内容的には upstream `writeOutboundDirect` (session-manager.ts:382) と
 * 同じ SQL だが、open 時に `openOutboundDb` (readonly) ではなく
 * `openOutboundDbRw` (writable) を使う点だけが違う。コミット時に書いた
 * doc コメント参照 — upstream の readonly バグへの一時回避。
 *
 * cross-mount invariant (session-manager.ts header) を守るため:
 *   - journal_mode=DELETE (openOutboundDbRw 内で設定済み)
 *   - 一回の write ごとに close (long-lived connection を作らない)
 *   - 一度に書くのはこの一行だけ (concurrent writer と競合しない想定)
 *
 * seq は upstream と同じ `MAX(seq)+2` で偶数を維持 (host=even, container=odd)。
 */
function writeOutboundMessage(message: {
  agentGroupId: string;
  sessionId: string;
  id: string;
  kind: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
}): void {
  const db = openOutboundDbRw(outboundDbPath(message.agentGroupId, message.sessionId));
  try {
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), ?, ?, ?, ?, ?)`,
    ).run(message.id, message.kind, message.platformId, message.channelType, message.threadId, message.content);
  } finally {
    db.close();
  }
}

/**
 * outbox ディレクトリ (`<session_dir>/outbox/<message_id>/`) を作成し、
 * 各 file を `outbox/<message_id>/<filename>` として書き込む。
 *
 * 書き込まれた filename 配列は messages_out.content の `files:` フィールドに
 * 載せる。delivery.ts は `readOutboxFiles(agentGroupId, sessionId, messageId, files)`
 * で読み戻して channel adapter に渡す (symmetric な設計、upstream
 * session-manager.ts:444-496)。
 *
 * ファイル名検証: upstream の `isSafeAttachmentName` を流用 (`..` / path
 * separator / NUL 拒否)。これは container 側 outbox 書き込みと同じガード。
 * outbox dir は host が所有するため pre-placed symlink リスクは inbound に
 * 関しては低いが、念のため `wx` フラグで exclusive create する。
 */
function writeOutboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  files: SkillExecutionNotificationFile[],
): string[] {
  if (!isSafeAttachmentName(messageId)) {
    throw new InboundHandlerError(500, `unsafe message id: ${messageId}`);
  }

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  fs.mkdirSync(outboxDir, { recursive: true });

  const writtenFilenames: string[] = [];
  for (const file of files) {
    if (!isSafeAttachmentName(file.filename)) {
      throw new InboundHandlerError(400, `unsafe filename: ${file.filename}`);
    }
    const buf = Buffer.from(file.contentBase64, 'base64');
    const filePath = path.join(outboxDir, file.filename);
    // wx = exclusive create. host は本 outbox dir の sole writer の想定。
    fs.writeFileSync(filePath, buf, { flag: 'wx' });
    writtenFilenames.push(file.filename);
  }
  return writtenFilenames;
}
