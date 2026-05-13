/**
 * host-tools handler barrel.
 *
 * 各 handler を `handlers` map に登録する。
 * host-tools-server がこの map から `POST /tools/<name>` の dispatch を行う。
 *
 * 命名規則 / カテゴリ分け (ADR-0009 / .deshi/docs/mcp-tool-naming.md):
 *   - `health`        — bridge 自身の生存確認 (例外、prefix なし)
 *   - `daemon_<name>` — deshi daemon の API を叩く (工程 4/5 で追加)
 *   - `tool_<name>`   — host で完結する処理 (将来追加)
 */

import { createHealthHandler } from './health.js';

export type HostToolHandler = (body: unknown) => Promise<unknown>;

export const handlers: Record<string, HostToolHandler> = {};

// health は他の handler 名一覧を返したいので、handlers 完成後に factory で生成して登録する。
handlers.health = createHealthHandler(() => Object.keys(handlers));
