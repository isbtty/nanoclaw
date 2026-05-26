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
import { daemonListSkillsHandler } from './deshi_daemon_list_skills.js';
import { daemonSearchFilesHandler } from './deshi_daemon_search_files.js';
import { daemonGogHandler } from './deshi_daemon_gog.js';
import { daemonSendFileToChatHandler } from './deshi_daemon_send_file_to_chat.js';

export type HostToolHandler = (body: unknown) => Promise<unknown>;

export const handlers: Record<string, HostToolHandler> = {};

// health は他の handler 名一覧を返したいので、handlers 完成後に factory で生成して登録する。
handlers.health = createHealthHandler(() => Object.keys(handlers));

handlers.deshi_daemon_run_skill = daemonRunSkillHandler as HostToolHandler;
handlers.deshi_daemon_poll_until_done = daemonPollUntilDoneHandler as HostToolHandler;
// list と refresh は HTTP 層では同じ handler を共有する (= deshi daemon が毎回
// disk scan するためキャッシュは持たない)。区別は agent 視点の意味付け (list は
// 起動時 discover、refresh は実行時 re-fetch) で行う。詳細は
// `src/deshi/host-tools/deshi_daemon_list_skills.ts` のヘッダコメント参照。
handlers.deshi_daemon_list_skills = daemonListSkillsHandler as HostToolHandler;
handlers.deshi_daemon_refresh_skills = daemonListSkillsHandler as HostToolHandler;
// deshi-wiki / deshi-raw 配下のハイブリッド検索 (qmd CLI バックエンド)。
// skill spawn を介さずに `GET /files/search` を直接 wrap するので、
// 1 ターンで複数回叩く探索用途に最適 (ADR-0009)。
handlers.deshi_daemon_search_files = daemonSearchFilesHandler as HostToolHandler;
// Google Calendar / Docs / Drive / Gmail (read) を gog CLI 経由で操作する。
// daemon 側 POST /gog の薄い wrapper。subcommand whitelist + `-a` 強制
// injection 等の安全策は deshi daemon 側 TS で deterministic に enforce
// するので、ここでは validation を最小限にして daemon のエラーを透過する。
handlers.deshi_daemon_gog = daemonGogHandler as HostToolHandler;
// agent がホスト上の deshi-raw / deshi-wiki 配下のファイル (qmd 検索で見つけた
// outputs/*.html 等) を現在の Telegram chat に届けるための経路。
// 内部実装は deshi `/files/content` でファイル本体を取って既存の
// skill-execution-notifications handler を in-process で再利用する。
handlers.deshi_daemon_send_file_to_chat = daemonSendFileToChatHandler as HostToolHandler;
