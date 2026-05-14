/**
 * host-tools handler barrel.
 *
 * 各 handler を `handlers` map に登録する。
 * host-tools-server がこの map から `POST /tools/<name>` の dispatch を行う。
 *
 * 命名規則 / カテゴリ分け (ADR-0009 / .deshi/docs/mcp-tool-naming.md):
 *   - `health`        — bridge 自身の生存確認 (例外、prefix なし)
 *   - `daemon_<name>` — deshi daemon の API を叩く
 *   - `tool_<name>`   — host で完結する処理 (将来追加)
 *
 * agent 側 MCP tool 名と HTTP path 側 handler key は 2 階層命名で異なる:
 *   - agent: mcp__deshi__daemon_run_skill
 *   - HTTP : POST /tools/deshi_daemon_run_skill
 * mapping は container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts で行う。
 */

import { createHealthHandler } from './health.js';
import { daemonRunSkillHandler } from './deshi_daemon_run_skill.js';
import { daemonPollUntilDoneHandler } from './deshi_daemon_poll_until_done.js';

export type HostToolHandler = (body: unknown) => Promise<unknown>;

export const handlers: Record<string, HostToolHandler> = {};

// health は他の handler 名一覧を返したいので、handlers 完成後に factory で生成して登録する。
handlers.health = createHealthHandler(() => Object.keys(handlers));

handlers.deshi_daemon_run_skill = daemonRunSkillHandler as HostToolHandler;
handlers.deshi_daemon_poll_until_done = daemonPollUntilDoneHandler as HostToolHandler;
