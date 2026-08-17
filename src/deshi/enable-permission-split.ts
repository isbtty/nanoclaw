/**
 * 初回セットアップの最後の一手 — この host を権限分離運用にする
 * (.deshi/adr/0019-bot-permission-split.md §5.3)。
 *
 *   SLACK_KNOWLEDGE_BOT_TOKEN=xoxb-... pnpm exec tsx src/deshi/enable-permission-split.ts \
 *     --knowledge-group <agent group id> --knowledge-instance slack-<suffix>
 *
 * `permission_split_config` に行を書くのが本体。行が出来た瞬間から、以後の
 * チャンネル登録の承認に権限分離の配線が続くようになる (§5.2)。
 *
 * トークン (`SLACK_KNOWLEDGE_BOT_TOKEN` 環境変数、または `--bot-token`) を渡すと
 * Slack の `auth.test` で知識検索BOT の user id を引いて一緒に保存する。保存するのは
 * user id だけでトークンは残さない。これが無いとチャンネルへの自動招待ができず、
 * 代わりに「招待してください」と案内する動きになる。**再実行でトークンを省いても、
 * 既に保存済みの user id は消えない。**
 *
 * operator が host 上で 1 回だけ実行する。冪等 (再実行は上書き)。
 */
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { initDb } from '../db/index.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getPermissionSplitConfig, setPermissionSplitConfig } from './permission-split.js';

interface Args {
  knowledgeGroup?: string;
  knowledgeInstance?: string;
  botToken?: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--knowledge-group') args.knowledgeGroup = argv[++i];
    else if (argv[i] === '--knowledge-instance') args.knowledgeInstance = argv[++i];
    else if (argv[i] === '--bot-token') args.botToken = argv[++i];
  }
  return args;
}

/**
 * 知識検索BOT の Slack user id を引く。引けなければ `null` を返して続行する
 * (招待だけができなくなる。セットアップ全体を止める理由にはならない)。
 */
export async function fetchBotUserId(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { ok?: boolean; user_id?: unknown; error?: unknown };
    if (data.ok !== true) {
      console.error(`auth.test failed: ${String(data.error)}`);
      return null;
    }
    return typeof data.user_id === 'string' ? data.user_id : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- 引けなくても続行する
  } catch (err) {
    console.error(`auth.test failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.knowledgeGroup || !args.knowledgeInstance) {
    console.error(
      'usage: enable-permission-split.ts --knowledge-group <agent group id> --knowledge-instance slack-<suffix>',
    );
    console.error('  トークンは SLACK_KNOWLEDGE_BOT_TOKEN 環境変数か --bot-token で渡す');
    process.exitCode = 1;
    return;
  }

  initDb(path.join(DATA_DIR, 'v2.db'));

  if (!getAgentGroup(args.knowledgeGroup)) {
    console.error(`agent group not found: ${args.knowledgeGroup}`);
    console.error('先に知識検索BOT 用の agent group を作ってください (ncl groups create)。');
    process.exitCode = 1;
    return;
  }

  // argv 経由だと同じ host の他ユーザーに ps で見えるため、env を優先する。
  const token = process.env.SLACK_KNOWLEDGE_BOT_TOKEN || args.botToken;
  const botUserId = token ? await fetchBotUserId(token) : null;

  setPermissionSplitConfig({
    knowledgeAgentGroupId: args.knowledgeGroup,
    knowledgeInstance: args.knowledgeInstance,
    knowledgeBotUserId: botUserId,
  });

  const saved = getPermissionSplitConfig();
  console.log('権限分離運用を有効にしました:');
  console.log(`  knowledge agent group: ${saved?.knowledge_agent_group_id}`);
  console.log(`  knowledge bot user id: ${saved?.knowledge_bot_user_id ?? '(未設定 — 自動招待は行われません)'}`);
  console.log('');
  console.log('以後、チャンネル登録の承認に続けて権限分離の配線が走ります。');
}

// 直接実行されたときだけ main を走らせる (テストから import できるようにするため)。
// ビルド後の .js でも動くよう拡張子を問わない。
if (/enable-permission-split\.(ts|js)$/.test(process.argv[1] ?? '')) {
  await main();
}
