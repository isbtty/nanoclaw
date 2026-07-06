/**
 * in-flight deshi job の永続化ストア (isbtty/deshi#523 対応策5)。
 *
 * `deshi_run_start` 多重発火ガードの状態 `LastRunStart {triggerSeq, jobId,
 * threadId}` は元々 shim (deshi-mcp-stdio.ts) の module-level 変数にしか無く、
 * コンテナ respawn で shim プロセスごと消えていた。すると:
 *   - respawn 後の run_start がガードをすり抜けて重複 job を生む
 *   - in-flight jobId が失われ、respawn した agent が poll を再開できない
 *
 * そこで workspace mount (respawn を跨いで残る) 上の 1 ファイルに JSON で退避する。
 *   - run_start が job を arm したとき save
 *   - run_poll が terminal (completed/failed/jobEvicted/daemonRestarted) を観測したとき clear
 *   - shim 起動時に load して lastRunStart を復元
 *
 * MCP server / DB / HTTP の副作用なしに単体テストできるよう、path を引数で取る
 * 純粋な read/write 関数に切り出している (run-start-guard.ts と同じ方針)。
 *
 * 単一スロット: deshi 委譲は「1 回 poll・再発火禁止」で 1 件ずつが前提なので、
 * 最新の 1 job だけを保持する (現行ガード意味論と一致)。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LastRunStart } from './run-start-guard.js';

/**
 * ストアから in-flight job を読む。ファイルが無い / JSON が壊れている /
 * 期待する型でない場合は null (復元しない)。壊れた state でガードを誤発火させない。
 */
export function loadInflightJob(path: string): LastRunStart | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // 未 arm / ファイル無し
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LastRunStart>;
    if (
      parsed &&
      typeof parsed.triggerSeq === 'number' &&
      typeof parsed.jobId === 'string' &&
      parsed.jobId.length > 0 &&
      typeof parsed.threadId === 'string'
    ) {
      return { triggerSeq: parsed.triggerSeq, jobId: parsed.jobId, threadId: parsed.threadId };
    }
  } catch {
    /* JSON でない / 破損 — 復元しない */
  }
  return null;
}

/**
 * in-flight job をストアに書く。親ディレクトリを作り、tmp + rename で atomic に
 * 置き換える (torn read を防ぐ)。書き込み失敗は握り潰す — 永続化はベストエフォート
 * であり、失敗しても in-memory の lastRunStart は生きているので当該 session は動く。
 */
export function saveInflightJob(path: string, rec: LastRunStart): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, path);
  } catch {
    /* best-effort */
  }
}

/**
 * ストアの in-flight job を消す (job が terminal に到達したとき)。ファイルが
 * 無ければ no-op。
 */
export function clearInflightJob(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}
