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

// ── host 単位の設定 (ADR-0019 §5.1) ──

export interface PermissionSplitConfig {
  /** 知識検索BOT の agent group。招待先の解決に使う。 */
  knowledge_agent_group_id: string;
  /** 知識検索BOT の Slack user id。チャンネル招待に使う。取得できていなければ null。 */
  knowledge_bot_user_id: string | null;
  enabled_at: string;
}

/**
 * この host が権限分離運用か。行が無ければ `null` = 従来運用。
 *
 * agent group 単位の {@link isPermissionSplitGroup} とは層が違う。チャンネル登録の
 * 時点ではそのチャンネルの agent group がまだ無いので、そこでの分岐はこちらを見る。
 */
export function getPermissionSplitConfig(): PermissionSplitConfig | null {
  const row = getDb().prepare('SELECT * FROM permission_split_config WHERE id = 1').get() as
    | PermissionSplitConfig
    | undefined;
  return row ?? null;
}

/** 初回セットアップから呼ぶ。既に有れば上書きする (冪等)。 */
export function setPermissionSplitConfig(config: {
  knowledgeAgentGroupId: string;
  knowledgeBotUserId?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO permission_split_config
         (id, knowledge_agent_group_id, knowledge_bot_user_id, enabled_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         knowledge_agent_group_id = excluded.knowledge_agent_group_id,
         knowledge_bot_user_id    = excluded.knowledge_bot_user_id,
         enabled_at               = excluded.enabled_at`,
    )
    .run(config.knowledgeAgentGroupId, config.knowledgeBotUserId ?? null, new Date().toISOString());
}
