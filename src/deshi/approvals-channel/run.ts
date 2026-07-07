/**
 * deshi#517 — `/deshi-route-approvals-to-channel` skill が実機（Mac mini host）で
 * 起動する CLI エントリ。central DB (`data/v2.db`) を開いて
 * {@link routeApprovalsToChannel} を実行し、結果を表示する。
 *
 * Usage:
 *   pnpm exec tsx src/deshi/approvals-channel/run.ts <slack-channel-id> [--name "<表示名>"]
 *
 * 例:
 *   pnpm exec tsx src/deshi/approvals-channel/run.ts C0123456789 --name "承認"
 *
 * 冪等。再実行しても同じ共有 mg に upsert されるだけ。
 */
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { getDb, initDb } from '../../db/connection.js';
import { routeApprovalsToChannel } from './wire.js';

function parseArgs(argv: string[]): { platformId?: string; name?: string } {
  const out: { platformId?: string; name?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') {
      out.name = argv[++i];
    } else if (!a.startsWith('--') && !out.platformId) {
      out.platformId = a;
    }
  }
  return out;
}

function main(): void {
  const { platformId, name } = parseArgs(process.argv.slice(2));
  if (!platformId) {
    console.error('Usage: pnpm exec tsx src/deshi/approvals-channel/run.ts <slack-channel-id> [--name "<表示名>"]');
    process.exit(2);
  }

  initDb(path.join(DATA_DIR, 'v2.db'));

  const result = routeApprovalsToChannel({ platformId, name });

  console.log('--- 承認通知の共有チャンネル配線 完了 ---');
  console.log(`messaging_group_id : ${result.messagingGroupId} (${result.created ? '新規作成' : '既存を再利用'})`);
  console.log(`入力 channel ID     : ${platformId}（保存時は slack: prefix 付きに正規化）`);
  console.log(`redirected (${result.redirected.length}) : ${result.redirected.join(', ') || '(なし)'}`);
  if (result.skipped.length > 0) {
    console.log(
      `skipped (${result.skipped.length})    : ${result.skipped.join(', ')}  ← slack identity でないため据え置き`,
    );
  }

  // deshi#528 修正前に prefix 無しで作った壊れた mg が残っていれば警告する。
  if (result.legacyMessagingGroupId) {
    console.log('\n⚠️  同一チャンネルの prefix 無し(壊れ) messaging_group を検出しました:');
    console.log(`    legacy mg id : ${result.legacyMessagingGroupId}`);
    console.log('    配線は正しい正規 mg に寄せ直し済みですが、壊れた mg が DB に残っています。');
    console.log('    router が誤発火した滞留カードがあれば手動で cleanup してください（例）:');
    console.log(
      `      pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM pending_channel_approvals WHERE messaging_group_id='${result.legacyMessagingGroupId}'"`,
    );
    console.log(
      `      pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM messaging_groups WHERE id='${result.legacyMessagingGroupId}'"`,
    );
  }

  // 検証用: 現在の user_dms を表示（誰がどこに向いているか）。
  const rows = getDb()
    .prepare(
      `SELECT ud.user_id, ud.channel_type, ud.messaging_group_id, mg.is_group, mg.platform_id
         FROM user_dms ud
         LEFT JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
        ORDER BY ud.user_id`,
    )
    .all() as {
    user_id: string;
    channel_type: string;
    messaging_group_id: string;
    is_group: number | null;
    platform_id: string | null;
  }[];
  console.log('\n--- 現在の user_dms ---');
  for (const r of rows) {
    const kind = r.is_group ? 'GROUP' : 'DM';
    console.log(`${r.user_id}  →  ${r.messaging_group_id}  [${kind} ${r.platform_id ?? '?'}]`);
  }
}

main();
