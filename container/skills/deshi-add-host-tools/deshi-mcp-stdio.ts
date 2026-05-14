/**
 * deshi MCP stdio server (container 内で実行)
 *
 * container 内 agent からの MCP tool 呼び出しを受け取り、host 側で動いている
 * host-tools-server (http://host.docker.internal:5180) に HTTP POST で転送する。
 *
 * 公開する tool:
 *   - health                  : bridge 自身の生存確認 (`POST /tools/health`)
 *   - daemon_run_skill        : deshi daemon の POST /run を叩く (工程 5)
 *   - daemon_poll_until_done  : deshi daemon の GET /jobs/:jobId を long polling
 *
 * agent 側 tool 名 (例: `daemon_run_skill`) と HTTP path 側 (例:
 * `deshi_daemon_run_skill`) は 2 階層命名で別。本ファイル内の `server.tool(...)`
 * 呼び出しで明示的に mapping する (ADR-0009)。
 *
 * 命名規則と新 tool 追加手順: `.deshi/docs/mcp-tool-naming.md`、`.deshi/adr/0009-mcp-tool-naming.md`。
 *
 * Env:
 *   DESHI_HOST_URL (default: http://host.docker.internal:5180)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DESHI_HOST_URL = process.env.DESHI_HOST_URL || 'http://host.docker.internal:5180';

function log(msg: string): void {
  console.error(`[DESHI] ${msg}`);
}

/**
 * host-tools-server (host 側) の `POST /tools/<name>` に転送する。
 * docker-internal が解決できない環境 (Linux host で network=host で動かす等) では
 * localhost にフォールバックする。
 */
async function hostFetch(toolName: string, args: unknown): Promise<Response> {
  const url = `${DESHI_HOST_URL}/tools/${toolName}`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
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

const server = new McpServer({
  name: 'deshi',
  version: '0.1.0',
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
// daemon_run_skill — deshi daemon に skill 実行を依頼 (POST /run)
// ─────────────────────────────────────────────────────────────
const channelContextSchema = z.object({
  channel: z.string().describe('Source platform name, e.g. "telegram" | "line" | "slack"'),
  platformId: z.string().describe('User identifier on the source platform'),
  threadId: z.string().describe('Thread / group / channel id ("dm" for direct messages)'),
  isGroup: z.boolean().describe('True if the source thread is a group/channel, false for DMs'),
});

const allowedSkillNames = z.enum([
  'sync',
  'ingest',
  'ingest-business-cards',
  'ingest-diary',
  'ingest-kindle',
]);

server.tool(
  'daemon_run_skill',
  'Submit a deshi skill for asynchronous execution. Returns a jobId; pair this call with daemon_poll_until_done to wait for the result. Only the 5 skills in NANOCLAW_SKILL_ALLOWLIST are allowed (others fail at the daemon).',
  {
    skillName: allowedSkillNames.describe(
      'Skill name (must be in NANOCLAW_SKILL_ALLOWLIST: sync / ingest / ingest-business-cards / ingest-diary / ingest-kindle)',
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
