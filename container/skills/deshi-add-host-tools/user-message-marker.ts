/**
 * run_start 多重発火ガードの「新しいユーザー発話が来たか」marker 読み出し。
 *
 * 従来は `messages_in.trigger = 1` (= agent を起こした発話) の MAX(seq) を
 * marker にしていたが、グループチャットでは @メンション無しの発話が
 * trigger=0 で記録されるため marker が進まず、正当な追撃依頼まで恒久的に
 * dedupe されていた。dedupe が返す直前の jobId は完了・retrieved 済みで
 * deshi daemon 側が 5 分後に GC しているため、agent からは「job が消失して
 * いるのに新規 job が作れない」というスタックに見える (再現ログ:
 * 2026-08-23 Telegram グループ。@メンション付き発話が来た瞬間だけ通る)。
 *
 * marker の意味は「ユーザー発話が新しく来たか」なので、trigger (起床判定)
 * ではなく kind (発話種別) で判定する:
 *   - 'chat' / 'chat-sdk' — ユーザー発話 (a2a 含む)。trigger 値に関係なく数える
 *   - 'webhook'           — deshi skill 実行結果の context 注入 (trigger=0)。
 *                           これで marker が進むと「job 完了通知そのもの」が
 *                           再委譲の免罪符になる穴が開くため数えない
 *   - 'task' / 'system'   — 内部イベント。同上
 *
 * shim (deshi-mcp-stdio.ts) から DB ハンドルを受け取る純粋関数に切り出し、
 * bun:sqlite の in-memory DB で単体テストできるようにしている
 * (run-start-guard.ts / inflight-job-store.ts と同じ方針)。
 */

/** bun:sqlite Database の必要最小インターフェース。 */
export interface MarkerDb {
  prepare(sql: string): { get(): unknown };
}

export const USER_MESSAGE_MARKER_SQL =
  "SELECT MAX(seq) AS m FROM messages_in WHERE kind IN ('chat', 'chat-sdk')";

/**
 * ユーザー発話 (kind IN ('chat','chat-sdk')) の MAX(seq) を返す。
 * 行が無ければ 0。読み出し例外は呼び出し側で -1 (ガード無効化) に落とす。
 */
export function readMaxUserMessageSeq(db: MarkerDb): number {
  const row = db.prepare(USER_MESSAGE_MARKER_SQL).get() as { m: number | null } | undefined;
  return row?.m ?? 0;
}
