/**
 * deshi MCP stdio server (container 内で実行)
 *
 * container 内 agent からの MCP tool 呼び出しを受け取り、host 側で動いている
 * host-tools-server (http://host.docker.internal:5180) に HTTP POST で転送する。
 *
 * 工程 3 時点で公開する tool:
 *   - health: bridge 自身の生存確認 (`POST /tools/health`)
 *
 * 工程 4 / 5 以降で deshi daemon を叩く tool (`daemon_*`) や、host 完結処理の
 * tool (`tool_*`) を追加していく。命名規則は ADR-0009 参照。
 *
 * Env:
 *   DESHI_HOST_URL (default: http://host.docker.internal:5180)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

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
// 工程 4/5 以降で追加する tool は以下のパターンで:
//
// server.tool(
//   'daemon_run_skill',
//   '<description>',
//   { /* zod schema */ },
//   async (args) => callHostTool('daemon_run_skill', args),
// );
// ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
