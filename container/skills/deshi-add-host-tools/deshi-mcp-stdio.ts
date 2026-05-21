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
 * 命名規則と新 tool 追加手順: `.deshi/docs/mcp-tool-naming.md`、`.deshi/adr/0009-mcp-tool-naming.md`。
 *
 * Env:
 *   DESHI_HOST_URL                  (default: http://host.docker.internal:5180)
 *   DESHI_MCP_STARTUP_FETCH_TIMEOUT_MS (default: 5000) — startup skill list fetch 上限
 */

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
// daemon_run_skill — deshi daemon に skill 実行を依頼 (POST /run)
//   description に起動時に取得した skill 一覧を埋め込む。
//   skillName 型は z.string() に緩和し、本物の allowlist 検証は
//   daemon 側 SkillRegistry に委譲する。
// ─────────────────────────────────────────────────────────────
const channelContextSchema = z.object({
  channel: z.string().describe('Source platform name, e.g. "telegram" | "line" | "slack"'),
  platformId: z.string().describe('User identifier on the source platform'),
  threadId: z.string().describe('Thread / group / channel id ("dm" for direct messages)'),
  isGroup: z.boolean().describe('True if the source thread is a group/channel, false for DMs'),
});

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
    channelContext: channelContextSchema,
  },
  async (args) => callHostTool('deshi_daemon_run_skill', args),
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

const transport = new StdioServerTransport();
await server.connect(transport);
