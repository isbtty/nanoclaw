/**
 * deshi#517 / boswell#712 — `/boswell-route-approvals-to-channel` skill が実機
 * （Mac mini host）で起動する CLI エントリ。central DB (`data/v2.db`) を開いて
 * {@link routeApprovalsToChannel} を実行し、結果を表示する。
 *
 * Usage:
 *   pnpm exec tsx src/deshi/approvals-channel/run.ts                          # 再配線（配線済みのチャンネルをそのまま）
 *   pnpm exec tsx src/deshi/approvals-channel/run.ts <slack-channel-id> [--name "<表示名>"]
 *   pnpm exec tsx src/deshi/approvals-channel/run.ts --clear
 *
 * 引数なしは配線済みチャンネルへの再配線。旧スナップショット方式からの移行や、
 * 配線が生きているかの確認をチャンネル ID を調べ直さずに行える。未配線なら usage で終わる。
 *
 * 冪等。再実行しても同じ共有 mg を指すだけ。
 */
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { getDb, initDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getApprovalsChannel } from './db.js';
import { clearApprovalsChannelWiring, routeApprovalsToChannel } from './wire.js';

function parseArgs(argv: string[]): { platformId?: string; name?: string; clear: boolean } {
  const out: { platformId?: string; name?: string; clear: boolean } = { clear: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') {
      out.name = argv[++i];
    } else if (a === '--clear') {
      out.clear = true;
    } else if (!a.startsWith('--') && !out.platformId) {
      out.platformId = a;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  initDb(path.join(DATA_DIR, 'v2.db'));

  if (args.clear) {
    clearApprovalsChannelWiring();
    console.log('--- 承認通知の共有チャンネル配線 解除 完了 ---');
    console.log('以降の承認カードは通常どおり approver の個人 DM に配信されます。');
    return;
  }

  // 引数なし = 配線済みチャンネルへの再配線。チャンネル ID を調べ直さずに
  // 旧スナップショットの掃除と現状確認ができる。
  let platformId = args.platformId;
  let rewired = false;
  if (!platformId) {
    const wiring = getApprovalsChannel('slack');
    const wiredMg = wiring ? getMessagingGroup(wiring.messaging_group_id) : undefined;
    if (!wiredMg) {
      console.error('まだ配線されていません。共有チャンネルの ID を指定してください:');
      console.error('  pnpm exec tsx src/deshi/approvals-channel/run.ts <slack-channel-id> [--name "<表示名>"]');
      console.error('  pnpm exec tsx src/deshi/approvals-channel/run.ts --clear   # 配線を解除');
      process.exit(2);
    }
    platformId = wiredMg.platform_id;
    rewired = true;
    console.log(`--- 配線済みチャンネルに再配線します: ${wiredMg.name ?? '(名前なし)'} (${platformId}) ---`);
  }

  const result = routeApprovalsToChannel({ platformId, name: args.name });

  console.log(`--- 承認通知の共有チャンネル${rewired ? '再' : ''}配線 完了 ---`);
  console.log(`messaging_group_id : ${result.messagingGroupId} (${result.created ? '新規作成' : '既存を再利用'})`);
  console.log(`入力 channel ID     : ${platformId}（保存時は slack: prefix 付きに正規化）`);
  console.log(`掃除した user_dms   : ${result.clearedSnapshotRows} 行（旧スナップショット方式の残骸）`);
  const saved = getApprovalsChannel('slack');
  console.log(`配線レコード        : deshi_approvals_channel(slack) → ${saved?.messaging_group_id ?? '(保存失敗)'}`);
  console.log(`現時点の対象 (${result.eligibleNow.length}) : ${result.eligibleNow.join(', ') || '(なし)'}`);
  console.log('  ↑ 参考値です。対象は配信のたびに user_roles から判定されるので、');
  console.log('    この配線の後に admin を付与した人も自動的に共有チャンネルに出ます。');

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
  // 掃除後の user_dms は本来の cold-DM キャッシュだけが残っているはず。
  // 共有 mg を指す行が残っていたら掃除漏れ。
  console.log('\n--- 現在の user_dms（cold-DM キャッシュ。共有 mg を指す行は無いはず）---');
  for (const r of rows) {
    const kind = r.is_group ? 'GROUP' : 'DM';
    const flag = r.messaging_group_id === result.messagingGroupId ? '  ⚠️ 共有 mg を指したまま' : '';
    console.log(`${r.user_id}  →  ${r.messaging_group_id}  [${kind} ${r.platform_id ?? '?'}]${flag}`);
  }
}

main();
