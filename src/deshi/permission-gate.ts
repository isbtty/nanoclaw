/**
 * 権限操作を「依頼した本人が admin なら即時実行」に切り替えるゲート
 * (.deshi/adr/0019-bot-permission-split.md §6)。
 *
 * nanoclaw の既定では、container から来る `access: 'approval'` のコマンドは
 * 誰の依頼かに関わらず承認カードに回る。権限分離モードの組織では
 * 「@管理者BOT @対象者 に権限を付与して」を admin がその場で通せる必要がある
 * ため、依頼者を {@link resolveTurnSender} で引いて判断する。
 *
 * ## 何を許すかは「誰が」だけでなく「何を」で決める
 *
 * 依頼者が admin であることは必要条件でしかない。ADR-0019 §3 は
 * **特権admin (global admin) をチャットから作れないこと**を要求しているので、
 * 操作の対象も縛る:
 *
 *   - `roles` は `--role admin` のみ。`owner` は常に拒否
 *   - `--group` は **明示されていて、かつ自分の agent group** のときだけ。省略も
 *     他 group も拒否する
 *
 * `--group` の省略を拒否するのが要点。role は global (`agent_group_id IS NULL`) か
 * group scoped かを `--group` の有無で決めるので、省略を素通しすると
 * 「`--role admin` だけ」で **global admin** が生え、revoke なら特権admin を
 * 剥奪できてしまう。`cli_scope='group'` では dispatch が auto-fill するので通るが、
 * `'global'` では auto-fill が走らないため、ここで fail-closed に倒す。
 *
 * ## 判定できないときは断らない
 *
 * 依頼者を特定できない (発言が混在している / 期限切れ 等) 場合は `defer` を返し、
 * **従来どおり承認カードに回す**。ADR-0019 §6 が求めているのは admin の即時化で
 * あって、フォールバックの撤去ではない。`deny` は「依頼者は分かったが権限が無い」
 * ときだけに絞る。
 *
 * 権限分離モードでない agent group は常に `defer`。既存の挙動は一切変えない
 * (ADR-0019 §0)。
 */
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { isPermissionSplitGroup } from './permission-split.js';
import { resolveTurnSender } from './turn-sender.js';

export type AgentRequestDecision =
  | { action: 'allow'; userId: string; argOverrides: Record<string, unknown> }
  | { action: 'deny'; message: string }
  | { action: 'defer' };

/** 依頼者を記録する引数名。resource ごとに違う。 */
const REQUESTER_ARG: Record<string, string> = { roles: 'granted_by', members: 'added_by' };

/** 依頼者が admin なら即時実行してよいコマンドの resource。 */
const IMMEDIATE_RESOURCES = new Set(['roles', 'members']);

/** `cli_scope='group'` のホワイトリストに、権限分離モードでだけ足すコマンド。 */
const GROUP_SCOPE_EXTRA_COMMANDS = new Set(['roles-grant', 'roles-revoke']);

/**
 * `cli_scope='group'` の resource ホワイトリストを、権限分離モードの agent group
 * にだけ広げる。
 *
 * コアの既定は `groups / sessions / destinations / members` で `roles` を含まない。
 * 権限分離モードでは「チャンネル内 admin が同じチャンネルの admin を増やす」が
 * 要件 (ADR-0019 §3) なので付与・剥奪だけを通す。**それ以外の agent group には
 * 一切影響しない** — 非分離なら false を返し、コア側の判定がそのまま効く。
 *
 * resource 単位ではなくコマンド単位で広げるのは、`roles list` が resource 定義に
 * `scopeField` を持たず、到達しても post-handler の fail-closed で必ず失敗する
 * ため。通しても使えないものを通さない。
 */
export function allowsResourceUnderGroupScope(agentGroupId: string, command: string): boolean {
  return GROUP_SCOPE_EXTRA_COMMANDS.has(command) && isPermissionSplitGroup(agentGroupId);
}

/**
 * container からの承認待ちコマンドを、即時実行 / 拒否 / 従来どおり承認カード
 * のどれにするか決める。
 */
export function decideAgentRequest(args: {
  agentGroupId: string;
  sessionId: string;
  resource: string | undefined;
  args: Record<string, unknown>;
  /** 承認カードからの replay か。対象の制約だけは replay でも効かせる。 */
  approved?: boolean;
}): AgentRequestDecision {
  const { agentGroupId, sessionId, resource, approved } = args;
  if (!isPermissionSplitGroup(agentGroupId)) return { action: 'defer' };
  if (!resource || !IMMEDIATE_RESOURCES.has(resource)) return { action: 'defer' };

  const violation = targetViolation(agentGroupId, resource, args.args);
  if (violation) return { action: 'deny', message: violation };

  // 承認済みの replay は、対象の制約さえ通れば本来の実行経路へ返す。
  if (approved) return { action: 'defer' };

  const turn = resolveTurnSender(agentGroupId, sessionId);
  // 依頼者を確定できないなら即時実行はしないが、断りもしない。承認カードに回す。
  if (!turn.ok) return { action: 'defer' };

  if (!hasAdminPrivilege(turn.userId, agentGroupId)) {
    return { action: 'deny', message: 'この操作は管理者のみ実行できます。' };
  }
  const requesterArg = REQUESTER_ARG[resource];
  return {
    action: 'allow',
    userId: turn.userId,
    argOverrides: requesterArg ? { [requesterArg]: turn.userId } : {},
  };
}

/**
 * 操作の対象が、チャットから触ってよい範囲に収まっているか。
 * 収まっていなければ利用者向けの理由を返す。
 */
function targetViolation(agentGroupId: string, resource: string, commandArgs: Record<string, unknown>): string | null {
  // 見るのは `--group` だけ。roles / members の handler が宛て先として読むのは
  // これ 1 つ (cli/resources/roles.ts, members.ts) で、`--agent_group_id` 等を
  // 「宛て先の明示」として認めると、handler 側では未指定 = global 扱いのまま
  // ゲートだけ通ってしまう。
  //
  // 省略や非文字列も拒否する。role は `--group` の有無で global か group scoped かが
  // 決まるので、省略を素通しすると「--role admin だけ」で global admin が生え、
  // revoke なら特権admin を剥奪できる。`cli_scope='group'` では dispatch が
  // auto-fill するので通るが、`'global'` では走らないためここで fail-closed に倒す。
  const group = commandArgs.group;
  if (group !== agentGroupId) {
    return 'このチャンネル以外の権限は、チャットからは変更できません。';
  }

  if (resource === 'roles' && commandArgs.role !== 'admin') {
    return 'チャットから付与・剥奪できるのは、このチャンネルの管理者権限だけです。';
  }
  return null;
}
