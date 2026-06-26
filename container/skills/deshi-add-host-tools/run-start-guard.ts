/**
 * run_start 多重発火ガードの純粋ロジック (isbtty/deshi#451 二次問題)。
 *
 * deshi-mcp-stdio.ts の `deshi_run_start` ハンドラ内にインラインで書いていた
 * 判定を、MCP server / DB / HTTP の副作用なしに単体テストできるよう切り出した
 * もの。挙動は元の inline ロジックと等価。
 */

export interface LastRunStart {
  triggerSeq: number;
  jobId: string;
  threadId: string;
}

/**
 * 今回の run_start を dedupe する (= deshi に転送せず既存 job を返す) べきかを判定。
 *
 * 直前の run_start 以降に新しい wake 発話が無い (triggerSeq 据え置き) なら、その
 * 既存 run を返す。転送すべき場合は null:
 *   - 直前の run_start が無い (初回)
 *   - 新しい wake で triggerSeq が前進した (正当な再依頼)
 *   - triggerSeq < 0 (messages_in を読めずガード無効化)
 */
export function shouldDedupeRunStart(
  last: LastRunStart | null,
  triggerSeq: number,
): LastRunStart | null {
  if (last && triggerSeq >= 0 && triggerSeq === last.triggerSeq) return last;
  return null;
}

/**
 * run_start を転送した後のガード状態を計算する。run が実際に開始した
 * (ok + jobId が parse でき) かつ triggerSeq が読めたときだけ新 job で arm する。
 * それ以外は直前状態を維持する (失敗を握り潰してガードに閉じ込めないため)。
 */
export function armRunStartGuard(
  prev: LastRunStart | null,
  triggerSeq: number,
  resText: string | undefined,
  isError: boolean,
): LastRunStart | null {
  if (triggerSeq < 0 || isError) return prev;
  try {
    const parsed = JSON.parse(resText ?? "") as {
      ok?: boolean;
      jobId?: string;
      threadId?: string;
    };
    if (parsed?.ok && parsed.jobId) {
      return { triggerSeq, jobId: parsed.jobId, threadId: parsed.threadId ?? "" };
    }
  } catch {
    /* レスポンスが JSON でない (想定外) ときは arm しない */
  }
  return prev;
}
