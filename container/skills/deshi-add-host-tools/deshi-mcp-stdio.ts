/**
 * deshi MCP stdio server (container 内で実行)
 *
 * container 内 agent からの MCP tool 呼び出しを受け取り、host 側で動いている
 * host-tools-server (http://host.docker.internal:5180) に HTTP POST で転送する。
 *
 * 公開する tool:
 *   - health                  : bridge 自身の生存確認 (`POST /tools/health`)
 *   - daemon_run_skill        : deshi daemon の POST /run を叩く
 *   - daemon_poll_until_done  : deshi daemon の GET /jobs/:jobId を long polling
 *   - daemon_send_file_to_chat: deshi-raw/deshi-wiki 配下のファイルを現在のチャットに送る
 *   - daemon_push_file_to_raw  : container 内のファイル (Telegram 添付等) を
 *                                deshi-raw の inbox/ または outputs/ に push (ADR-0008)
 *
 * agent 側 tool 名 (例: `daemon_run_skill`) と HTTP path 側 (例:
 * `deshi_daemon_run_skill`) は 2 階層命名で別。本ファイル内の `server.tool(...)`
 * 呼び出しで明示的に mapping する (ADR-0009)。
 *
 * Skill 解決の委譲:
 *   nanoclaw は skill 一覧を持たず、skillName の型も `z.string()` に緩和してある。
 *   skill 解決と expose-to-nanoclaw allowlist 検証は deshi daemon 側 (SkillRegistry)
 *   に委譲する (ADR-0009 passthrough)。
 *
 * channelContext の自動注入 (https://github.com/isbtty/deshi/issues/267):
 *   agent に channelContext を fabricate させると、formatter が routing
 *   フィールドを context から落とすため誤った platformId/threadId が deshi
 *   daemon に伝わっていた。これを修正するため、agent からは channelContext を
 *   受け取らず、container 内の `session_routing` table (host が wake 時に
 *   id=1 1行で書く) から直接 channel / platformId / threadId を読み出して
 *   inject する。
 *
 *   session_routing は権威ある source なので fabricate のリスクが消え、agent
 *   側の引数 schema も単純化される。`isGroup` は誰も使っていなかったので併せて
 *   廃止 (nanoclaw inbound 側は messaging_groups.is_group を DB から引く)。
 *
 * 命名規則と新 tool 追加手順: `.deshi/docs/mcp-tool-naming.md`、`.deshi/adr/0009-mcp-tool-naming.md`。
 *
 * Env:
 *   DESHI_HOST_URL                  (default: http://host.docker.internal:5180)
 *   DESHI_INBOUND_DB_PATH           (default: /workspace/inbound.db) — session_routing 読み出し先
 */

import { Database } from 'bun:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { shouldDedupeRunStart, armRunStartGuard, type LastRunStart } from './run-start-guard.js';
import { loadInflightJob, saveInflightJob, clearInflightJob } from './inflight-job-store.js';
import { hostFetch } from './host-fetch.js';

const DESHI_HOST_URL = process.env.DESHI_HOST_URL || 'http://host.docker.internal:5180';
/**
 * 知識検索BOT 用の絞り込み profile (.deshi/adr/0019-bot-permission-split.md §4)。
 * true のとき `health` と `knowledge_search` 以外を登録しない。外部の人が居る
 * 部屋で動くため、skill 実行とファイル操作の口を最初から生やさない。
 */
const KNOWLEDGE_PROFILE = process.env.DESHI_MCP_PROFILE === 'knowledge';

function log(msg: string): void {
  console.error(`[DESHI] ${msg}`);
}

/**
 * 汎用 tool ハンドラ。host-tools-server に転送し、レスポンス JSON を
 * MCP tool result の text content として返す。
 */
async function callHostTool(toolName: string, args: unknown): Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}> {
  log(`>>> ${toolName} ${JSON.stringify(args ?? {})}`);
  try {
    const res = await hostFetch(DESHI_HOST_URL, toolName, args, undefined, { log });
    const text = await res.text();
    if (!res.ok) {
      return {
        content: [{ type: 'text' as const, text: `Host service returned ${res.status}: ${text}` }],
        isError: true,
      };
    }
    log(`<<< ${toolName} ok`);
    return {
      content: [{ type: 'text' as const, text }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Failed to reach deshi host service at ${DESHI_HOST_URL}: ${message}` }],
      isError: true,
    };
  }
}

const server = new McpServer({
  name: 'boswell',
  version: '0.2.0',
});

// ─────────────────────────────────────────────────────────────
// health — bridge 自身の生存確認 (恒久 handler)
// ─────────────────────────────────────────────────────────────
server.tool(
  'health',
  'Check that the deshi host-tools bridge is alive. Returns version, uptime, current timestamp, and the list of registered handlers on the host side. Use this to diagnose bridge connectivity before invoking other deshi tools.',
  {},
  async () => callHostTool('health', {}),
);

// daemon_list_skills / daemon_refresh_skills / daemon_search_files は削除 (ADR-0009 passthrough)。
// skill 解決も wiki/raw 検索も deshi 側 (deshi_run_start) に委譲する。nanoclaw は持たない。

// ─────────────────────────────────────────────────────────────
// session_routing reader — agent の代わりに channelContext を組み立てる
//   `data/v2-sessions/<group>/<session>/inbound.db` が container に
//   bind mount される。この DB の `session_routing` から必ずその session の
//   channel / platformId / threadId が取れる (host が wake 時に書く)。
//   agent に fabricate させない (https://github.com/isbtty/deshi/issues/267)。
// ─────────────────────────────────────────────────────────────
const INBOUND_DB_PATH = process.env.DESHI_INBOUND_DB_PATH || '/workspace/inbound.db';

interface ChannelContext {
  channel: string;
  platformId: string;
  threadId?: string;
}

/**
 * `session_routing` (id=1) を 1 行読み、`{channel, platformId, threadId?}` を返す。
 *
 * 接続は毎回 open/close — host との cross-mount visibility (journal_mode=DELETE)
 * を確実に取るため。channel_type / platform_id が欠落していれば throw (fabricate
 * しない方針)。thread_id は thread を持たない channel (Telegram DM 等) では
 * 空文字 / null で書かれるのが正常系なので、その場合は threadId キー自体を
 * 付けずに返す (deshi #258 で threadId? optional 化済み)。
 *
 * session_routing.thread_id が空 (Slack group 等の channel 単位 session) の
 * ときは、返信経路 (poll-loop.ts resolveDestinationThread) と同じく最新
 * inbound メッセージの thread_id にフォールバックして threadId を揃える。
 */
function readSessionRouting(): ChannelContext {
  const db = new Database(INBOUND_DB_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  try {
    const row = db
      .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
      .get() as
      | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
      | undefined;
    if (!row) {
      throw new Error('session_routing row missing — container wake did not populate routing');
    }
    if (!row.channel_type || !row.platform_id) {
      throw new Error(
        `session_routing has null field(s) — channel_type=${row.channel_type} platform_id=${row.platform_id}`,
      );
    }
    const result: ChannelContext = {
      channel: row.channel_type,
      platformId: row.platform_id,
    };
    // session_routing.thread_id は channel 単位で書かれるため、Slack group の
    // ような per-thread でない session では空になる。container 側の返信経路
    // (poll-loop.ts resolveDestinationThread) は代わりに「同一 channel の最新
    // inbound メッセージの thread_id」でスレッドに返す。host 側の中間 ack
    // (post-deshi-ack) はこの channelContext.threadId しか参照しないので、
    // session_routing が空のままだと ack だけ channel トップに落ち、最終回答
    // はスレッドに付くという不一致が出る (isbtty/deshi#445 関連)。返信経路と
    // 同じ source にフォールバックして threadId を揃える。
    let threadId = row.thread_id || null;
    if (!threadId) {
      const inbound = db
        .prepare(
          `SELECT thread_id FROM messages_in
           WHERE channel_type = ? AND platform_id = ? AND thread_id IS NOT NULL
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(row.channel_type, row.platform_id) as { thread_id: string | null } | undefined;
      if (inbound?.thread_id) threadId = inbound.thread_id;
    }
    if (threadId) result.threadId = threadId;
    return result;
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────
// run_start 多重発火ガード (isbtty/deshi#451 二次問題)
//   症状: agent が 1 つのユーザー発話に対し deshi_run_start を投げ直し、毎回
//   別の deshi job (別 threadId) が生まれて多重発火する (input が膨らみながら
//   何本も走る)。失敗/未完を「もう一回」と誤解した自発再委譲が主因。
//
//   nanoclaw だけが「前回 run_start 以降に新しい wake 発話が来たか」を判定できる
//   (deshi daemon は run 呼び出ししか見えず、引き金のユーザー発話を見られない)。
//   そこで shim 側で構造的に抑止する:
//     - messages_in.trigger=1 (= agent を起こした発話) の MAX(seq) を marker とする。
//     - 直前の run_start 時の marker と同じ = 新しいユーザー発話が無い → 2 本目の
//       run_start を deshi に転送せず、直前の job を返して「それを poll しろ」と誘導。
//       deshi 側に新 job を作らせない。
//     - 新しい wake 発話が来て marker が進めば、正当な新規依頼として通す。
//   これにより「ユーザーが明示的に再依頼したケース」(marker 前進) は誤抑止しない。
//
//   状態は module-level (= この session の container 内で持続)。container は 1
//   session を扱うので session を跨がない。
// ─────────────────────────────────────────────────────────────
// 判定ロジックは run-start-guard.ts (純粋・単体テスト済) に切り出している。
//
// respawn 越しの永続化 (isbtty/deshi#523 対応策5): lastRunStart は module-level
// なのでコンテナ respawn で消える → ガードが無効化され重複 job を生み、in-flight
// jobId も失われる。workspace mount 上のファイルに退避し、起動時に復元する。
const INFLIGHT_JOB_PATH =
  process.env.DESHI_INFLIGHT_JOB_PATH || '/workspace/agent/.deshi/last-run-start.json';
let lastRunStart: LastRunStart | null = loadInflightJob(INFLIGHT_JOB_PATH);
if (lastRunStart) {
  log(`Restored in-flight deshi job from previous container: ${lastRunStart.jobId}`);
}

/**
 * agent を起こした発話 (messages_in.trigger=1) の MAX(seq) を返す。新しいユーザー
 * 発話が来たかどうかの marker。読めない場合は -1 (ガードを無効化し転送を許す)。
 */
function readMaxTriggerSeq(): number {
  const db = new Database(INBOUND_DB_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  try {
    const row = db.prepare('SELECT MAX(seq) AS m FROM messages_in WHERE trigger = 1').get() as
      | { m: number | null }
      | undefined;
    return row?.m ?? 0;
  } finally {
    db.close();
  }
}

function readSenderToken(): string | undefined {
  const db = new Database(INBOUND_DB_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  try {
    const row = db
      .prepare('SELECT content FROM messages_in WHERE trigger = 1 ORDER BY seq DESC LIMIT 1')
      .get() as { content: string } | undefined;
    if (!row) return undefined;
    const content = JSON.parse(row.content) as { senderToken?: unknown };
    return typeof content.senderToken === 'string' ? content.senderToken : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

server.tool(
  'knowledge_search',
  '現在の部屋で公開が許可された知識だけを検索して質問に回答する。ユーザーの質問を query にそのまま渡す。',
  { query: z.string() },
  async (args) => callHostTool('deshi_daemon_knowledge_search', { ...args, senderToken: readSenderToken() }),
);

// ─────────────────────────────────────────────────────────────
// daemon_run_skill — deshi daemon に skill 実行を依頼 (POST /run)
//   description に起動時に取得した skill 一覧を埋め込む。
//   skillName 型は z.string() に緩和し、本物の allowlist 検証は
//   daemon 側 SkillRegistry に委譲する。
//   channelContext は agent からは受け取らず、`session_routing` から自動注入。
// ─────────────────────────────────────────────────────────────
if (!KNOWLEDGE_PROFILE) {
  server.tool(
    'boswell_run_start',
    'boswell に処理を委譲する唯一の dispatch 窓口。ユーザー発話・質問・相談・依頼を、内容を問わず input にそのまま渡す（skill 名が明確なら "/boswell-<skill> <args>" も可）。boswell 側で skill 解決して非同期実行し jobId を返す。結果は boswell_run_poll で取得する。nanoclaw は自分で答えたり Google/検索を直接行ったりしない — すべてここに流す。',
    {
      input: z
        .string()
        .describe('ユーザー発話そのまま、または "/boswell-<skill> <args>"。非空。'),
    },
    async (args) => {
      let channelContext: ChannelContext;
      try {
        channelContext = readSessionRouting();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to read session_routing for channelContext injection: ${message}`,
            },
          ],
          isError: true,
        };
      }

      // 多重発火ガード (#451 二次): 前回 run_start 以降に新しい wake 発話が無いまま
      // 2 本目の run_start が来たら、新 job を作らず直前の job を返して poll に誘導する。
      let triggerSeq: number;
      try {
        triggerSeq = readMaxTriggerSeq();
      } catch {
        triggerSeq = -1; // 読めなければガード無効化 (転送を許す)
      }
      const deduped = shouldDedupeRunStart(lastRunStart, triggerSeq);
      if (deduped) {
        log(`run_start deduped: no new wake message since job ${deduped.jobId} (triggerSeq=${triggerSeq})`);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                jobId: deduped.jobId,
                threadId: deduped.threadId,
                deduped: true,
                note:
                  '前回の run_start 以降に新しいユーザー発話がありません。新しい job は作成せず、進行中の既存 job を返しました。' +
                  'これを boswell_run_poll で待ってください。既に失敗していた場合は結果をユーザーに報告し、' +
                  'ユーザーが新しく明示的に依頼するまで run_start を投げ直さないでください。',
              }),
            },
          ],
        };
      }

      const res = await callHostTool('deshi_daemon_run_skill', { ...args, channelContext });

      // 成功して jobId が取れたらガードを arm する。失敗/非 JSON 時は更新しないので
      // 次回も転送される (失敗を握り潰してガードに閉じ込めない)。
      const prevRunStart = lastRunStart;
      lastRunStart = armRunStartGuard(lastRunStart, triggerSeq, res.content?.[0]?.text, res.isError ?? false);
      // 新しい job を arm できたら respawn 越しに残るよう永続化 (対応策5)。
      if (lastRunStart && lastRunStart !== prevRunStart) {
        saveInflightJob(INFLIGHT_JOB_PATH, lastRunStart);
      }
      return res;
    },
  );
}

// ─────────────────────────────────────────────────────────────
// daemon_poll_until_done — long polling で daemon の job 完了を待つ
//   host-tools-server 側で internal retry を回すため、agent は 1 回呼ぶだけで
//   completed/failed の最終状態を受け取れる。retry ループは書かなくて良い。
// ─────────────────────────────────────────────────────────────
if (!KNOWLEDGE_PROFILE) {
  server.tool(
    'boswell_run_poll',
    'Wait for a job submitted via boswell_run_start to reach a terminal state (completed/failed). host-tools-server retries GET /jobs internally; this MCP call returns once. Possible flags on the response: daemonRestarted (the daemon was restarted mid-job), timedOut (timeoutMs expired before completion), jobEvicted (the daemon no longer has this job — it was dropped, e.g. its retention window expired; this is terminal, do NOT retry the same jobId — re-run from boswell_run_start if needed).',
    {
      jobId: z.string().describe('jobId returned by boswell_run_start'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max wait time in milliseconds (default 1800000 = 30 minutes)'),
    },
    async (args) => {
      // channelContext を session_routing から注入する。host 側 poll handler が
      // 「遅い job のとき中間 ack を配信」するために使う (isbtty/deshi#423)。
      // 読み出し失敗時は channelContext 無しで poll を続行 (ack は出ないが本体は動く)。
      let channelContext: ChannelContext | undefined;
      try {
        channelContext = readSessionRouting();
      } catch {
        channelContext = undefined;
      }
      const res = await callHostTool('deshi_daemon_poll_until_done', {
        ...args,
        ...(channelContext ? { channelContext } : {}),
      });

      // job が terminal (completed / failed。jobEvicted・daemonRestarted は failed
      // で返る) に達したら、この session の in-flight 永続を消す (対応策5)。timedOut
      // は status='pending' のままなので残す (まだ in-flight)。呼び出された jobId が
      // 永続中の job と一致するときだけ消す (別 job の poll で取り違えない)。
      if (!res.isError && args.jobId === lastRunStart?.jobId) {
        try {
          const parsed = JSON.parse(res.content?.[0]?.text ?? '') as { status?: string };
          if (parsed.status === 'completed' || parsed.status === 'failed') {
            clearInflightJob(INFLIGHT_JOB_PATH);
          }
        } catch {
          /* レスポンスが JSON でない (想定外) ときは何もしない */
        }
      }
      return res;
    },
  );
}

// daemon_gog は削除 (ADR-0009 passthrough)。Google 操作は deshi_run_start に委譲する。

// ─────────────────────────────────────────────────────────────
// daemon_send_file_to_chat
//   Deliver a file from the deshi host (deshi-raw or deshi-wiki) to the
//   CURRENT chat the agent is talking on. Use this when `daemon_search_files`
//   returned a useful artifact (`outputs/.../*.html`, a meeting note PDF, …)
//   and the user wants it forwarded. The host fs is NOT mounted inside this
//   container, so `send_file` cannot reach those paths directly — this tool
//   bridges that gap.
//
//   channelContext is auto-injected from `session_routing` (same pattern as
//   daemon_run_skill) so the agent does not pass it. The path is the same
//   value `daemon_search_files` returned in `results[].path` (relative to
//   deshi dataDir, e.g. "outputs/2026-05-26-foo/bar.html").
// ─────────────────────────────────────────────────────────────
if (!KNOWLEDGE_PROFILE) {
  server.tool(
    'daemon_send_file_to_chat',
    [
      'Deliver a file living on the deshi host (under deshi-raw or deshi-wiki) to the current chat as an attachment. Use this after `daemon_search_files` finds an HTML / PDF / image artifact the user wants forwarded — the host fs is NOT mounted in this container, so `send_file` cannot reach those paths directly.',
      '',
      'The `path` is the same form returned by `daemon_search_files` (`results[].path`, relative to deshi dataDir, e.g. `outputs/2026-05-26-morning-weather/morning-weather.html`). Optional `text` is sent as a 1-line caption alongside the file. Optional `filename` overrides the display name shown in chat (default: basename of path).',
      '',
      'Returns `{ok, sessionId, messageId, filename}`.',
    ].join('\n'),
    {
      path: z
        .string()
        .describe('Relative path under deshi-raw or deshi-wiki (e.g. "outputs/2026-05-26-foo/bar.html")'),
      text: z.string().optional().describe('Optional caption sent alongside the file (default: empty)'),
      filename: z
        .string()
        .optional()
        .describe('Optional display filename override (default: basename of path)'),
    },
    async (args) => {
      let channelContext: ChannelContext;
      try {
        channelContext = readSessionRouting();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to read session_routing for channelContext injection: ${message}`,
            },
          ],
          isError: true,
        };
      }
      return callHostTool('deshi_daemon_send_file_to_chat', { ...args, channelContext });
    },
  );
}

// ─────────────────────────────────────────────────────────────
// daemon_push_file_to_raw
//   Push a file that lives INSIDE this container (e.g. an inbound Telegram
//   attachment saved under /tmp) to deshi-raw via `POST /files/upload`
//   (ADR-0008 / ADR-0009). Mirrors the passthrough policy: nanoclaw does NOT
//   hold business state, every received file is shipped to deshi immediately
//   and the local copy is removed by the caller.
//
//   Allowed `dest_subpath` prefixes are enforced by deshi daemon:
//     - inbox/<source>/<YYYY-MM-DD>/<filename>   (= raw inbox staging)
//     - outputs/<YYYY-MM-DD>-<slug>/<filename>   (= deshi-generated artifacts)
//
//   Implementation: read `local_path` inside the container, compute sha256,
//   base64-encode, and forward via host-tools-server. The base64 body is
//   bounded by host-tools-server's MAX_BODY_BYTES (150 MiB); the raw cap here
//   is kept at ~1/1.37 of that to leave room for base64 overhead + JSON keys.
//   This covers typical inbound chat attachments (e.g. a 54 MB PDF). For files
//   beyond this a streaming multipart pipeline (MCP stdio → host-tools-server →
//   daemon /files/upload) should replace base64-in-JSON; see follow-up.
// ─────────────────────────────────────────────────────────────
const MAX_PUSH_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB raw → ~133 MiB base64

if (!KNOWLEDGE_PROFILE) {
  server.tool(
    'daemon_push_file_to_raw',
    [
      'Push a file located inside this container to deshi-raw via the deshi daemon (ADR-0008). Use this for inbound chat attachments (Telegram/LINE PDF / image / voice) and for any artifact the agent must hand off to deshi for further processing. After a successful call, delete the local file — nanoclaw must not retain business state (ADR-0009 passthrough).',
      '',
      'Allowed dest_subpath prefixes (enforced by deshi daemon):',
      '- inbox/<source>/<YYYY-MM-DD>/<filename>  — raw inbox staging for ingest',
      '- outputs/<YYYY-MM-DD>-<slug>/<filename>  — deshi-generated artifacts',
      '',
      `Max raw file size for this call: ${MAX_PUSH_FILE_BYTES} bytes (~100 MiB). Larger files are rejected before transfer.`,
      '',
      'Outcome values in the response:',
      '- created           — first time write succeeded',
      '- skipped_same_sha  — identical content already at that path (idempotent re-send)',
      '- renamed_collision — inbox path existed with different content; written as `<name>-<sha8>.<ext>`',
      '- overwritten       — outputs path replaced because overwrite=true was set',
      '',
      'On 409 (outputs/ collision) re-run with overwrite=true if replacement is intended.',
    ].join('\n'),
    {
      local_path: z
        .string()
        .describe('Absolute path inside this container (e.g. /tmp/whitepaper.pdf). The file is read here, transferred, and the caller is responsible for deleting the local copy after success.'),
      dest_subpath: z
        .string()
        .describe('Destination relative to deshi-raw (e.g. "inbox/nanoclaw/2026-06-10/whitepaper.pdf").'),
      source: z
        .string()
        .optional()
        .describe('Source label written to the deshi audit log (e.g. "nanoclaw").'),
      overwrite: z
        .boolean()
        .optional()
        .describe('Allow overwriting an existing outputs/ artifact. Has no effect for inbox/ (always renamed on collision).'),
    },
    async (args) => {
      const { local_path, dest_subpath, source, overwrite } = args;
      try {
        // Lazy import to keep cold-start light; only needed when this tool runs.
        const { readFile, stat } = await import('node:fs/promises');
        const { createHash } = await import('node:crypto');

        const st = await stat(local_path);
        if (!st.isFile()) {
          return {
            content: [{ type: 'text' as const, text: `local_path is not a regular file: ${local_path}` }],
            isError: true,
          };
        }
        if (st.size > MAX_PUSH_FILE_BYTES) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `file ${local_path} is ${st.size} bytes which exceeds the ${MAX_PUSH_FILE_BYTES}-byte limit for this transfer path`,
              },
            ],
            isError: true,
          };
        }
        const buf = await readFile(local_path);
        const sha256 = createHash('sha256').update(buf).digest('hex');
        const file_b64 = buf.toString('base64');

        return callHostTool('deshi_daemon_push_file_to_raw', {
          file_b64,
          sha256,
          dest_subpath,
          ...(source !== undefined ? { source } : {}),
          ...(overwrite !== undefined ? { overwrite } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Failed to push ${local_path}: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
