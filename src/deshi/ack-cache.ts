/**
 * deshi 中間 ack を動的化するための in-memory cache。
 *
 * **jobId → 動的 ack 文 (haiku 要約結果)** を保持するだけ。
 *
 * - run_skill handler が input を haiku で要約した結果をここに置く (`putJobAck`)
 * - poll_until_done handler が ack 送信時に引いて override 文に使う (`getJobAck`)
 * - job 完了/失敗時に開放する (`forgetJob`)
 *
 * session+thread 単位の「ack 連投抑止」は post-deshi-ack.ts の sqlite (messages_out)
 * ベース cooldown が担当しており、ここでは関与しない。in-memory はプロセス再起動で
 * 消えるが、要約は 1 job 用なので問題ない (job も同時に再起動でリセットされる)。
 *
 * プロセス内 only (再起動で消える)。host-tools-server は単一プロセスなので race
 * condition は気にしない。
 */
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // 30 分

interface JobRecord {
  ackText: string;
  storedAt: number;
}

const jobStore = new Map<string, JobRecord>();

function pruneJobs(now: number, ttlMs: number): void {
  for (const [k, v] of jobStore) {
    if (now - v.storedAt > ttlMs) jobStore.delete(k);
  }
}

/**
 * jobId に対応する動的 ack 文 (haiku 要約結果) を保存する。
 * 既存値がある場合は上書きしない (haiku が遅延して上書きされ古い説明になるのを防ぐ)。
 */
export function putJobAck(jobId: string, ackText: string, now: number = Date.now()): void {
  if (jobStore.has(jobId)) return;
  pruneJobs(now, DEFAULT_JOB_TTL_MS);
  jobStore.set(jobId, { ackText, storedAt: now });
}

/**
 * jobId に対応する動的 ack 文を取り出す。無ければ undefined。
 */
export function getJobAck(jobId: string, now: number = Date.now()): string | undefined {
  pruneJobs(now, DEFAULT_JOB_TTL_MS);
  return jobStore.get(jobId)?.ackText;
}

/**
 * job 完了/失敗時に呼ぶ。jobId の動的 ack を破棄してメモリを返す。
 */
export function forgetJob(jobId: string): void {
  jobStore.delete(jobId);
}

/**
 * テスト用 — store を全消去。プロダクションでは呼ばない。
 */
export function _resetAckCacheForTests(): void {
  jobStore.clear();
}
