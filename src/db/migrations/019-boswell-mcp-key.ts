import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * deshi → boswell リネーム (isbtty/boswell ADR-0036) の cross-repo 追従。
 *
 * host-tools bridge の MCP server は agent から `mcp__<key>__*` として見える。
 * この `<key>` は container_configs.mcp_servers (JSON) のトップレベルキーで、
 * boswell daemon が配信する delegation fragment が指す `mcp__boswell__*` と
 * 一致していなければ channel dispatch が spawn 毎に無言で不発になる。
 *
 * 旧デプロイでは key が `deshi` のため、`"deshi":` → `"boswell":` にリネームする。
 * 値 (command/args/env) は据え置き — args の `deshi-add-host-tools/...` パスや
 * `DESHI_HOST_URL` env は内部配管であり、`"deshi":` (小文字 + 直後コロン) には
 * マッチしないので影響しない。既に boswell 化済みの行は LIKE ガードで skip。
 */
export const migration019: Migration = {
  version: 19,
  name: 'boswell-mcp-key',
  up(db: Database.Database) {
    db.prepare(
      `UPDATE container_configs
         SET mcp_servers = replace(mcp_servers, '"deshi":', '"boswell":')
       WHERE mcp_servers LIKE '%"deshi":%'`,
    ).run();
  },
};
