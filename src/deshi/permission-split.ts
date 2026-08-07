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
  return (
    getDb().prepare('SELECT 1 FROM permission_split_groups WHERE agent_group_id = ?').get(agentGroupId) !== undefined
  );
}

/** 権限分離モードに登録する。冪等。 */
export function enablePermissionSplit(agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT INTO permission_split_groups (agent_group_id, enabled_at)
       VALUES (?, ?)
       ON CONFLICT(agent_group_id) DO NOTHING`,
    )
    .run(agentGroupId, new Date().toISOString());
}

/**
 * DM への知識スコープリンク自動発行を飛ばすか。
 *
 * 権限分離モードの組織では、知識検索はチャンネルでのみ行い DM は対象外と決めて
 * いる (ADR-0019)。DM の channel scope は「その人の私的チャットに知識を開ける」
 * という誰も依頼していない権限付与になるため。
 *
 * **それ以外の組織では従来どおり発行する** (ADR-0019 §0)。権限分離を入れずに
 * 使う場合、bot と DM でやり取りしたい場面は普通にあり、そこで知識を引けないと
 * 困る。`/update-knowledge-scope` からの明示発行はどちらの場合も通る。
 */
export function skipsDmScopeLink(agentGroupId: string, isGroup: boolean): boolean {
  return !isGroup && isPermissionSplitGroup(agentGroupId);
}
