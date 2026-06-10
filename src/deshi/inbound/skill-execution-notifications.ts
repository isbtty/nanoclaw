/**
 * Handler: deshi daemon からの skill 実行結果通知を受け付け、
 *
 *   1. messages_out に書き込んで Telegram 等への即時配信を起動する
 *      (添付ファイル本体は outbox/<message_id>/<filename> に配置)
 *   2. messages_in にも `kind='webhook', trigger=0` で書き込んで agent の
 *      context 注入のみ行う (起床はさせない)。添付ファイル本体は
 *      writeSessionMessage の extractAttachmentFiles 経由で
 *      inbox/<message_id>-in/<filename> にも展開され、agent が Read ツール等で
 *      中身を読めるようになる
 *
 * の両方を行う (ADR-0011 パターン A)。これによりユーザーは即時に Telegram で
 * 通知 (本文+添付) を受け取り、後で「さっきの通知のファイル中身は?」のように
 * 返信した時にも agent が文脈と添付ファイル内容まで保持して応答できる
 * (会話継続性の維持)。
 *
 * - HTTP path: POST /inbound/deshi/skill-execution-notifications
 * - 認証: dispatch 側で Bearer <DESHI_DAEMON_DEVICE_SECRET> を一括検証
 * - 命名規則: ADR-0010 (kebab-case、direct HTTP receiver 系統)
 * - 詳細仕様: isbtty/deshi#247 + ADR-0011
 *
 * 設計の要点:
 *
 *   1. なぜ messages_out だけでは不十分か (ADR-0011):
 *      agent (container 内 Claude) は Claude Agent SDK の native session
 *      continuation で会話を継続する。SDK session には agent が Anthropic API
 *      を叩いて返ってきた assistant message しか積まれないため、外部から
 *      messages_out に書いた行は agent の context に乗らない。messages_in に
 *      `kind='webhook'` で書くと、upstream getPendingMessages が trigger 値に
 *      関係なく全件取得する性質を利用して、次にユーザーが起床メッセージを
 *      送った時 prompt に webhook 行も乗る。SDK session に記録されて会話
 *      継続性が成立する。
 *
 *   2. session 解決ロジックは upstream router.ts と一致させる:
 *      ユーザー依頼時の router 経路で作られる session と「同じ session」に
 *      書き込まないと、依頼 session と通知 session が乖離して会話継続性が
 *      壊れる。effectiveSessionMode の判定ロジックは upstream
 *      router.ts:410-413 から **コピー** している (ADR-0002 維持のため
 *      upstream の関数 export には依存しない)。upstream 側で判定が変わった
 *      場合、本コピーを追随する必要がある。
 *
 *   3. adapterSupportsThreads は静的マップで保持 (ADR-0010 §5):
 *      host-tools-server は host 本体と別プロセスで起動するため、
 *      channel adapter registry が空。getChannelAdapter() を呼んでも
 *      undefined が返るので、inbound 側に hard-code した SUPPORTS_THREADS を
 *      参照する。新規 channel が upstream に追加された場合は本マップへの
 *      追加が必要 (CONTRIBUTING / PR レビュー観点で吸収)。
 *
 *   4. 添付ファイル本体は outbox と inbox の 2 か所に重複保存される
 *      (ADR-0011 Trade-offs): Telegram 配信ルートは delivery.ts が outbox を
 *      読み、agent 認知ルートは formatter が messages_in の content から
 *      localPath を agent に渡して agent が inbox を Read する、という経路の
 *      違いから発生する。session 寿命の間だけの一時コピーで session sweep /
 *      clearOutbox で自然に消えるため運用上の負担は限定的。
 *
 * 注意 (ADR-0010 §7):
 *   本 handler は getMessagingGroupByPlatform / resolveSession 等を介して
 *   central DB (`data/v2.db`) を読み書きする。host-tools-server プロセス内で
 *   `initDb()` が事前に呼ばれている前提 (`src/deshi/host-tools-server.ts` の
 *   起動シーケンス参照)。host 本体とは別プロセスで起動する以上、本プロセス
 *   独自に DB connection を開く必要がある。
 */

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { getMessagingGroupByPlatform, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { openOutboundDbRw } from '../../db/session-db.js';
import { resolveSession, outboundDbPath, sessionDir, writeSessionMessage } from '../../session-manager.js';
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
  // src/deshi/channels/line.ts (deshi 固有、LINE は thread 概念なし)
  line: false,
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

  // 5-6. attachment 書き込み + messages_out への INSERT (ADR-0011 パターン A)
  //
  // Telegram 等の chat adapter (`@chat-adapter/telegram`) は 1 message = 1 file
  // 制限があり、 N>1 files を 1 row に詰めると ValidationError で配信
  // 失敗する。そのため N file payload は **N rows × 1 file each** に
  // split する。 row 0 が `req.message` 本文 + 1 file、 row 1..N-1 は
  // file-only。multi-file ネイティブ対応の adapter (Discord 等) は messages
  // が増える程度の degradation で済む。
  //
  // outbox dir layout:
  //   outbox/<base>/<file0>      ← row 0 (本文 text + file0)
  //   outbox/<base>-1/<file1>    ← row 1 (file-only)
  //   outbox/<base>-(N-1)/<fileN-1>
  //
  // ファイル無し (0 files) → row 0 1 個に text のみ (legacy 動作維持)。
  // ファイル 1 個      → row 0 1 個に text + file (legacy 動作維持、 outbox = `<base>`)。
  //
  // messages_in (step 7) 側は 1 logical event として 1 row に集約する
  // (split しない) — agent context には「1 つの skill 実行で N ファイルが
  // 返った」として乗せたいため。
  //
  // content schema は container 側の send_file / send_message と同じ
  // `{ text, files: string[] }` JSON を採用 (upstream
  // container/agent-runner/src/mcp-tools/core.ts:173)。
  // kind は 'chat' を採用 — system は内部 action 用 (delivery.ts:255)、
  // chat は通常配信のデフォルトで host の delivery polling が pickup する。
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
  //
  // message_id は upstream の `isSafeAttachmentName` を通る形式 (basename
  // 安全) で生成する。crypto.randomUUID() は `-` のみで構成されるため OK。
  const messageId = `deshi-inbound-${randomUUID()}`;
  const incomingFiles = req.files ?? [];
  const rowCount = Math.max(1, incomingFiles.length);
  const allFilenames: string[] = [];

  for (let i = 0; i < rowCount; i++) {
    const isFirst = i === 0;
    const rowId = isFirst ? messageId : `${messageId}-${i}`;
    const rowIncoming = i < incomingFiles.length ? [incomingFiles[i]!] : [];
    const rowFilenames =
      rowIncoming.length > 0 ? writeOutboxFiles(agent.agent_group_id, session.id, rowId, rowIncoming) : [];
    allFilenames.push(...rowFilenames);

    writeOutboundMessage({
      agentGroupId: agent.agent_group_id,
      sessionId: session.id,
      id: rowId,
      kind: 'chat',
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: req.threadId ?? session.thread_id ?? null,
      content: JSON.stringify({
        text: isFirst ? req.message : '',
        files: rowFilenames,
      }),
    });
  }

  // 7. messages_in への INSERT — agent への context 注入 (ADR-0011 パターン A)
  //
  // (6) の messages_out 書き込みは Telegram への即時配信に使うだけで、
  // agent (container 内 Claude) の context には乗らない。agent は Claude
  // Agent SDK の native session continuation (`session_state` の
  // `continuation:claude`) で会話を継続しており、自分の発言履歴の真実の
  // ソースは Anthropic クラウド SDK session 側にある。SDK session には
  // agent が API を叩いて返ってきた assistant message しか積まれないため、
  // 外部から messages_out に書いた行は context に入らない。
  //
  // そこで messages_in にも同時に書き込み、次にユーザーが本物のメッセージで
  // 起床したとき (= countDueMessages が trigger=1 行をカウントしたとき) に
  // getPendingMessages が trigger 値に関係なく全件取得する性質を利用して、
  // webhook 行を一緒に prompt に乗せる。これで SDK session に「過去に
  // こんな通知が来た」という事実が記録され、会話継続性が成立する。
  //
  // - kind = 'webhook' → upstream formatter.ts の formatWebhookMessage が
  //   `<webhook source="..." event="...">payload</webhook>` の XML で整形する。
  //   ユーザー発言 (`<message>`) とは別タグなので、agent が「ユーザーが
  //   投稿した」と誤認することはない
  // - trigger = 0 → host 側 countDueMessages (WHERE trigger=1) が起床判定で
  //   カウントしないため、本書き込みだけでは agent は起床しない (API
  //   コストゼロ、即時配信の Telegram 通知ともレース無し)
  // - attachments: 添付ファイルの base64 を `attachments[].data` として
  //   content に同梱する。writeSessionMessage 内の extractAttachmentFiles が
  //   data を decode して `inbox/<message_id>-in/<filename>` に書き出し、
  //   content の data フィールドを削除して `localPath` を挿入する。
  //   結果として agent prompt の <webhook> 内 JSON には
  //   `attachments: [{ name, localPath }]` が乗り、agent は localPath を
  //   `Read` ツール等で開いてファイル中身を context に取り込める。
  //   実体ファイルは messages_out 側 outbox と messages_in 側 inbox の
  //   2 か所に重複保存されるが、これは Telegram 配信ルート (outbox) と
  //   agent 認知ルート (inbox) で読まれる場所が分かれている結果として許容する
  //   (ADR-0011 Trade-offs 参照)
  writeSessionMessage(agent.agent_group_id, session.id, {
    id: `${messageId}-in`,
    kind: 'webhook',
    timestamp: new Date().toISOString(),
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: req.threadId ?? session.thread_id ?? null,
    content: JSON.stringify({
      source: 'deshi',
      event: 'skill-execution-result',
      payload: {
        text: req.message,
        files: allFilenames,
      },
      attachments:
        req.files?.map((f) => ({
          name: f.filename,
          data: f.contentBase64,
        })) ?? [],
    }),
    trigger: 0,
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
