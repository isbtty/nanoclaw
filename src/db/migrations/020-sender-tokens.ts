import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Sender tokens (.deshi/adr/0020-sender-token.md)。
 *
 * container 経由の呼び出しは「誰の依頼か」「どのチャンネルか」を container の
 * 申告値に頼っており、権限判定に使えない。host が inbound ごとに不透明な
 * トークンを発行してここに控え、`ncl` / host-tool 側はトークンから
 * (user_id, messaging_group_id, agent_group_id) を引き直す。
 *
 * expires_at は ISO 8601 文字列。TTL 切れの行は host-sweep が掃除する
 * (索引はその走査用)。
 *
 * FK はすべて ON DELETE CASCADE。中央 DB は foreign_keys=ON で動くため、
 * cascade を付けないと `ncl groups delete` (agent group → sessions → ... と
 * FK 順に子を消すトランザクション) や `deleteUser` が、生きたトークンを持つ
 * 相手に対して FOREIGN KEY constraint failed で全体ロールバックする。
 * トークンは 30 分で失効する使い捨てなので、親が消えるなら道連れで正しい。
 */
export const migration020: Migration = {
  version: 20,
  name: 'sender-tokens',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE sender_tokens (
        token              TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        issued_at          TEXT NOT NULL,
        expires_at         TEXT NOT NULL
      );
      CREATE INDEX idx_sender_tokens_expires ON sender_tokens(expires_at);
    `);
  },
};
