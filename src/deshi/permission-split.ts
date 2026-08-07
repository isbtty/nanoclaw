/**
 * 権限分離モードの適用範囲 (.deshi/adr/0019-bot-permission-split.md §0)。
 *
 * BOT 権限分離は一部の組織にだけ必要な構成なので、**既存の挙動は一切変えない**
 * のが原則。挙動が変わるのは、セットアップスキルがここに登録した agent group
 * だけ。同じ host 上で従来運用と権限分離運用が併存するため、グローバルな env
 * フラグではなく agent group 単位で持つ。
 *
 * 分岐を入れる側は必ず {@link isPermissionSplitGroup} を通し、false のときは
 * 従来どおりの経路をそのまま走らせること。
 */
import { getDb } from '../db/connection.js';

/** この agent group が権限分離モードか。未登録なら false = 従来どおり。 */
export function isPermissionSplitGroup(agentGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS present FROM permission_split_groups WHERE agent_group_id = ?')
    .get(agentGroupId) as { present: number } | undefined;
  return row !== undefined;
}

/** 権限分離モードに登録する。冪等。 */
export function enablePermissionSplit(agentGroupId: string, now: Date = new Date()): void {
  getDb()
    .prepare(
      `INSERT INTO permission_split_groups (agent_group_id, enabled_at)
       VALUES (?, ?)
       ON CONFLICT(agent_group_id) DO NOTHING`,
    )
    .run(agentGroupId, now.toISOString());
}

/** 権限分離モードから外す。外すと従来の挙動に戻る。 */
export function disablePermissionSplit(agentGroupId: string): boolean {
  return getDb().prepare('DELETE FROM permission_split_groups WHERE agent_group_id = ?').run(agentGroupId).changes > 0;
}

/** 登録済みの agent group id を返す (診断・一覧用)。 */
export function listPermissionSplitGroups(): string[] {
  return (
    getDb().prepare('SELECT agent_group_id FROM permission_split_groups ORDER BY enabled_at').all() as Array<{
      agent_group_id: string;
    }>
  ).map((r) => r.agent_group_id);
}
