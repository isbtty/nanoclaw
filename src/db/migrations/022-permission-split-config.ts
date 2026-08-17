import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * この host が権限分離運用かどうか (.deshi/adr/0019-bot-permission-split.md §5.1)。
 *
 * agent group 単位の `permission_split_groups` (migration 021) とは層が違う:
 *
 *   - 本表 … **host が権限分離運用か**。チャンネル登録の承認直後に、続けて配線するか
 *            の分岐に使う。チャンネル登録の時点ではそのチャンネルの agent group が
 *            まだ存在しないため、agent group 単位では判定できない
 *   - 021  … **その agent group が権限分離済みか**。個々の判定 (DM の scope-link 抑止、
 *            権限操作の即時実行) に使う
 *
 * 行は初回セットアップ (host 上で operator が実行) でだけ作られる。行が無ければ
 * この host は従来運用のまま。`id` を 1 に固定して 1 行しか持てないようにする。
 */
export const migration022: Migration = {
  version: 22,
  name: 'permission-split-config',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE permission_split_config (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        knowledge_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        knowledge_bot_user_id    TEXT,
        enabled_at               TEXT NOT NULL
      );
    `);
  },
};
