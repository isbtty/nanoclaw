import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * 権限分離モードの適用範囲 (.deshi/adr/0019-bot-permission-split.md §0)。
 *
 * BOT 権限分離は一部の組織にだけ必要な構成であり、既存の全顧客に配るものでは
 * ない。「セットアップ済みかどうか」をこの表で持ち、分岐はすべてここを見る。
 * 行が無い agent group は従来どおりの挙動のまま — グローバルな env フラグに
 * しないのは、同じ host 上で両方の運用が併存するため。
 *
 * 登録はセットアップスキルが行う。手で剥がしたいときは行を消せば元に戻る。
 */
export const migration021: Migration = {
  version: 21,
  name: 'permission-split-groups',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE permission_split_groups (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        enabled_at     TEXT NOT NULL
      );
    `);
  },
};
