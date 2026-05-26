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
 *   - daemon_list_skills      : 起動時の skill 一覧 discovery
 *   - daemon_refresh_skills   : 実行時の skill 一覧 re-fetch
 *   - daemon_search_files     : deshi-wiki/deshi-raw の hybrid search (qmd 経由)
 *   - daemon_gog              : Google Calendar/Docs/Drive/Gmail を gog CLI 経由で操作
 *   - daemon_send_file_to_chat: deshi-raw/deshi-wiki 配下のファイルを現在のチャットに送る
 *
 * agent 側 tool 名 (例: `daemon_run_skill`) と HTTP path 側 (例:
 * `deshi_daemon_run_skill`) は 2 階層命名で別。本ファイル内の `server.tool(...)`
 * 呼び出しで明示的に mapping する (ADR-0009)。
 *
 * Skill allowlist の動的化:
 *   起動時に `daemon_list_skills` を呼んで現時点の expose-to-nanoclaw 付き skill を
 *   取得し、`daemon_run_skill` の description に注入する。起動時 fetch が失敗した
 *   場合は generic description で fallback (agent は `daemon_refresh_skills` を
 *   呼んで再取得できる)。skillName の型は `z.string()` に緩和してあり、本物の
 *   allowlist 検証は deshi daemon 側 (SkillRegistry) に委譲する。
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
 *   DESHI_MCP_STARTUP_FETCH_TIMEOUT_MS (default: 5000) — startup skill list fetch 上限
 *   DESHI_INBOUND_DB_PATH           (default: /workspace/inbound.db) — session_routing 読み出し先
 */

import { Database } from 'bun:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DESHI_HOST_URL = process.env.DESHI_HOST_URL || 'http://host.docker.internal:5180';
const STARTUP_FETCH_TIMEOUT_MS = parseInt(
  process.env.DESHI_MCP_STARTUP_FETCH_TIMEOUT_MS ?? '5000',
  10,
);

function log(msg: string): void {
  console.error(`[DESHI] ${msg}`);
}

/**
 * host-tools-server (host 側) の `POST /tools/<name>` に転送する。
 * docker-internal が解決できない環境 (Linux host で network=host で動かす等) では
 * localhost にフォールバックする。
 */
async function hostFetch(toolName: string, args: unknown, signal?: AbortSignal): Promise<Response> {
  const url = `${DESHI_HOST_URL}/tools/${toolName}`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
    ...(signal ? { signal } : {}),
  };
  try {
    return await fetch(url, init);
  } catch (err) {
    if (DESHI_HOST_URL.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, init);
    }
    throw err;
  }
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
    const res = await hostFetch(toolName, args);
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

// ─────────────────────────────────────────────────────────────
// Startup skill discovery — 起動時に 1 回 host-tools-server から
// `daemon_list_skills` を呼んで、現時点の公開 skill 一覧を取得する。
// 取れたら `daemon_run_skill` の description に埋め込んで agent が判断
// しやすくする。取れなかった場合は generic description で fallback。
// ─────────────────────────────────────────────────────────────

export interface ExposedSkill {
  name: string;
  description: string;
  argumentHint?: string;
}

export async function fetchSkillsAtStartup(
  timeoutMs: number = STARTUP_FETCH_TIMEOUT_MS,
): Promise<ExposedSkill[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await hostFetch('deshi_daemon_list_skills', {}, controller.signal);
    if (!res.ok) {
      log(`startup skill fetch: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      skills?: ExposedSkill[];
    };
    if (!Array.isArray(data.skills)) {
      log(`startup skill fetch: unexpected body shape`);
      return null;
    }
    log(`startup skill fetch: ${data.skills.length} skill(s)`);
    return data.skills;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`startup skill fetch failed: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildRunSkillDescription(skills: ExposedSkill[] | null): string {
  const intro =
    'Submit a deshi skill for asynchronous execution. Returns a jobId; pair this call with daemon_poll_until_done to wait for the result. The deshi daemon enforces a server-side allowlist (SKILL.md `expose-to-nanoclaw: true`), so submissions that do not match return an error.';

  if (!skills || skills.length === 0) {
    return [
      intro,
      '',
      'Currently exposed skills are unknown (startup discovery did not complete). Call `daemon_refresh_skills` first to populate the list, then pick a skillName from the result.',
    ].join('\n');
  }

  const bullets = skills
    .map((s) => {
      const hint = s.argumentHint ? ` (args: ${s.argumentHint})` : '';
      return `- ${s.name}${hint}: ${s.description}`;
    })
    .join('\n');

  return [
    intro,
    '',
    'Currently exposed skills:',
    bullets,
    '',
    'If the user asks for a skill not in this list, call `daemon_refresh_skills` to re-fetch — a newer skill may have been added since startup.',
  ].join('\n');
}

const server = new McpServer({
  name: 'deshi',
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

// ─────────────────────────────────────────────────────────────
// daemon_list_skills / daemon_refresh_skills
//   両者は HTTP 層では同じ handler (deshi_daemon_list_skills) を共有する。
//   agent には 2 つの tool として見せ、意味付けで使い分けてもらう:
//     - list   : 起動時に現在の expose-to-nanoclaw skill を discover
//     - refresh: 実行中に skill が増えた可能性を疑った時に re-fetch
// ─────────────────────────────────────────────────────────────
server.tool(
  'daemon_list_skills',
  'List the deshi skills currently exposed to nanoclaw (SKILL.md `expose-to-nanoclaw: true`). Returns `{schemaVersion, skills: [{name, description, argumentHint?}]}`. Useful at the start of a session to learn what `daemon_run_skill` will accept.',
  {},
  async () => callHostTool('deshi_daemon_list_skills', {}),
);

server.tool(
  'daemon_refresh_skills',
  'Re-fetch the list of deshi skills exposed to nanoclaw. Use this when the user requests a skill that was not in the startup list — a customer fork may have added new skills after the session started. Returns the same shape as `daemon_list_skills`.',
  {},
  async () => callHostTool('deshi_daemon_refresh_skills', {}),
);

// ─────────────────────────────────────────────────────────────
// daemon_search_files
//   Hybrid (semantic + lexical) search over deshi-wiki / deshi-raw via the
//   `qmd` CLI on the host. Direct primitive — does NOT spawn a skill, so it
//   is cheap enough for the agent to call multiple times in one turn while
//   triangulating where information lives ("did we already write about X?",
//   "find any past meetings with Y").
// ─────────────────────────────────────────────────────────────
server.tool(
  'daemon_search_files',
  'Search deshi-wiki / deshi-raw using hybrid (semantic + lexical) ranking. Returns `{schemaVersion?, query, results: [{path, name, score, snippet}], totalCount, indexedAt}`. Use this for ad-hoc lookups across the user\'s knowledge base — cheaper than calling a skill since it goes directly to the daemon. Examples: find prior writeups by topic, locate the meeting note with someone, see whether a concept already has a wiki entry.',
  {
    query: z.string().describe('Search query (Japanese OK, non-empty)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum results to return (default 20, range 1-100)'),
  },
  async (args) => callHostTool('deshi_daemon_search_files', args),
);

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
    if (row.thread_id) result.threadId = row.thread_id;
    return result;
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────
// daemon_run_skill — deshi daemon に skill 実行を依頼 (POST /run)
//   description に起動時に取得した skill 一覧を埋め込む。
//   skillName 型は z.string() に緩和し、本物の allowlist 検証は
//   daemon 側 SkillRegistry に委譲する。
//   channelContext は agent からは受け取らず、`session_routing` から自動注入。
// ─────────────────────────────────────────────────────────────
const startupSkills = await fetchSkillsAtStartup();
const runSkillDescription = buildRunSkillDescription(startupSkills);

server.tool(
  'daemon_run_skill',
  runSkillDescription,
  {
    skillName: z
      .string()
      .describe(
        'Skill name (e.g. "sync"). Must be one of the skills returned by `daemon_list_skills` / `daemon_refresh_skills` — submitting a non-exposed skill fails at the daemon.',
      ),
    args: z
      .string()
      .optional()
      .describe('Optional arguments string appended after the skill name (e.g. "--full")'),
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
    return callHostTool('deshi_daemon_run_skill', { ...args, channelContext });
  },
);

// ─────────────────────────────────────────────────────────────
// daemon_poll_until_done — long polling で daemon の job 完了を待つ
//   host-tools-server 側で internal retry を回すため、agent は 1 回呼ぶだけで
//   completed/failed の最終状態を受け取れる。retry ループは書かなくて良い。
// ─────────────────────────────────────────────────────────────
server.tool(
  'daemon_poll_until_done',
  'Wait for a job submitted via daemon_run_skill to reach a terminal state (completed/failed). host-tools-server retries GET /jobs internally; this MCP call returns once. Possible flags on the response: daemonRestarted (the daemon was restarted mid-job), timedOut (timeoutMs expired before completion).',
  {
    jobId: z.string().describe('jobId returned by daemon_run_skill'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max wait time in milliseconds (default 1800000 = 30 minutes)'),
  },
  async (args) => callHostTool('deshi_daemon_poll_until_done', args),
);

// ─────────────────────────────────────────────────────────────
// daemon_gog
//   Run a whitelisted gog CLI subcommand (Calendar / Docs / Drive / Gmail-read
//   / auth-status) via deshi daemon POST /gog. Direct primitive — no skill
//   spawn, no secondary Claude session. Use when the user wants to:
//     - check / create / update calendar events
//     - create / write Google Docs
//     - search / share / list Drive files
//     - read Gmail (list / search / get)
//   Destructive operations (delete / send / login / logout) are blocked
//   server-side and will return an error if requested — direct the user to
//   the CLI instead.
// ─────────────────────────────────────────────────────────────
server.tool(
  'daemon_gog',
  [
    'Run a `gog` CLI subcommand on the host to operate Google services. Subcommand path is dot-separated (e.g. "calendar.events", "docs.create", "gmail.messages.list"). Pass any additional CLI args as a string array — each element is one argv item.',
    '',
    'Allowed subcommands (server-enforced whitelist):',
    '- calendar.events / calendar.event / calendar.calendars / calendar.acl (read)',
    '- calendar.create / calendar.update (non-destructive write)',
    '- docs.create / docs.write / docs.info / docs.export',
    '- drive.ls / drive.search / drive.share / drive.download / drive.upload',
    '- gmail.messages.list / gmail.messages.get / gmail.messages.search / gmail.labels.list / gmail.threads.list / gmail.threads.get',
    '- auth.status / auth.list',
    '',
    'Blocked (will return 403): any delete / remove, gmail.send, auth.add, auth.remove. The daemon also injects `-a <account>` so caller-supplied `-a` / `--account` / `--client` / `--enable-commands` args are rejected.',
    '',
    'Returns `{ok, subcommand, stdout, stderr, exitCode}`. The agent should choose the appropriate `--plain` / `--json` flag in `args` to control output format.',
  ].join('\n'),
  {
    subcommand: z
      .string()
      .describe('Dot-separated subcommand path (e.g. "calendar.events")'),
    args: z
      .array(z.string())
      .optional()
      .describe('Additional CLI args, one element per argv item (e.g. ["--days", "1", "--plain"])'),
    timeout: z
      .number()
      .int()
      .min(1000)
      .max(5 * 60_000)
      .optional()
      .describe('Subprocess timeout in ms (default 30000, max 300000)'),
  },
  async (args) => callHostTool('deshi_daemon_gog', args),
);

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

const transport = new StdioServerTransport();
await server.connect(transport);
