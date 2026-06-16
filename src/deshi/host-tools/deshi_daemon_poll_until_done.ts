/**
 * Handler: deshi daemon の `GET /jobs/:jobId` を retry しながら completed/failed
 * まで待ち、最終状態を 1 レスポンスで返す long polling handler。
 *
 * HTTP path : POST /tools/deshi_daemon_poll_until_done
 * agent tool: mcp__deshi__daemon_poll_until_done
 *
 * agent は本 handler を 1 回呼ぶだけで結果を受け取れる。polling loop は
 * host-tools-server 側で完結する (案 B、isbtty/deshi#199 工程 5)。
 *
 * deshi daemon の `GET /jobs/:jobId` には auto-auth が通らないため、
 * `DESHI_DAEMON_DEVICE_SECRET` 環境変数の Bearer を必須とする。
 *
 * 中間 ack の構造配信 (isbtty/deshi#423):
 *   job が `DESHI_RUN_ACK_THRESHOLD_MS` (default 8s) を超えても pending の
 *   ときに 1 回だけ、host が messages_out に「確認しています」ack を書き込む
 *   (postDeshiRunAck)。fast job は閾値前に terminal になるので ack を出さない。
 *   channelContext は shim (deshi-mcp-stdio.ts) が session_routing から注入する。
 *   prompt 依存だった中間返信を LLM 非依存で保証するための構造対応。
 */

import { postDeshiRunAck, type DeshiAckChannelContext } from '../post-deshi-ack.js';

const DAEMON_RESTARTED_SENTINEL = 'daemon が再起動したため、この job の実行状態は失われました。';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 分 (deshi daemon の job TTL = 15 分 + 余裕)
const DEFAULT_RETRY_MS = 1000; // daemon が retryAfterMs を返さなかった時のフォールバック
const MAX_RETRY_MS = 5000; // retryAfterMs が大きすぎる時の上限
const MIN_RETRY_MS = 100; // 0/負数を渡された場合の下限
const DEFAULT_ACK_THRESHOLD_MS = 8000; // この秒数を超えて pending なら中間 ack を出す

function ackThresholdMs(): number {
  const raw = process.env.DESHI_RUN_ACK_THRESHOLD_MS;
  if (!raw) return DEFAULT_ACK_THRESHOLD_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ACK_THRESHOLD_MS;
}

export interface DaemonPollUntilDoneRequest {
  jobId: string;
  /** 全体タイムアウト (ms)。default 30 分 */
  timeoutMs?: number;
  /**
   * 中間 ack 配信先。shim が session_routing から注入する。無い場合は
   * ack をスキップする (後方互換: 古い shim から呼ばれても polling は動く)。
   */
  channelContext?: DeshiAckChannelContext;
}

export interface JobStatusResponse {
  status: 'pending' | 'completed' | 'failed';
  success?: boolean;
  result?: string;
  error?: string;
  progress?: { message?: string };
  retryAfterMs?: number;
  durationMs?: number;
  threadId?: string;
}

export interface DaemonPollUntilDoneResponse extends JobStatusResponse {
  /** daemon 再起動 sentinel を検出した場合 true */
  daemonRestarted?: boolean;
  /** timeoutMs を超えた場合 true (status は最後に観測した pending のまま) */
  timedOut?: boolean;
  /** polling で発行した GET /jobs リクエストの総回数 (デバッグ用) */
  pollCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampRetry(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_RETRY_MS;
  if (ms < MIN_RETRY_MS) return MIN_RETRY_MS;
  if (ms > MAX_RETRY_MS) return MAX_RETRY_MS;
  return ms;
}

export async function daemonPollUntilDoneHandler(body: unknown): Promise<DaemonPollUntilDoneResponse> {
  const req = body as DaemonPollUntilDoneRequest;
  if (!req || typeof req.jobId !== 'string' || req.jobId.length === 0) {
    throw new Error('daemonPollUntilDone: jobId is required');
  }

  const deshiUrl = process.env.DESHI_DAEMON_URL ?? 'http://localhost:3100';
  const secret = process.env.DESHI_DAEMON_DEVICE_SECRET;
  if (!secret) {
    throw new Error('DESHI_DAEMON_DEVICE_SECRET is not set on host-tools-server');
  }

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const ackAfter = ackThresholdMs();
  let ackSent = false;
  let pollCount = 0;
  let lastData: JobStatusResponse = { status: 'pending' };

  while (Date.now() < deadline) {
    const res = await fetch(`${deshiUrl}/jobs/${req.jobId}`, {
      headers: { Authorization: `Bearer ${secret}:nanoclaw` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`deshi daemon /jobs failed: ${res.status} ${text}`);
    }

    lastData = (await res.json()) as JobStatusResponse;
    pollCount++;

    if (lastData.status !== 'pending') {
      const daemonRestarted = lastData.status === 'failed' && lastData.error === DAEMON_RESTARTED_SENTINEL;
      return { ...lastData, daemonRestarted, pollCount };
    }

    // 中間 ack: 閾値秒を超えて pending のとき 1 回だけ「確認しています」を配信
    // (#423)。fast job はこの分岐前に terminal を返すので ack は出ない。
    if (!ackSent && req.channelContext && Date.now() - startedAt >= ackAfter) {
      ackSent = postDeshiRunAck(req.channelContext) || ackSent;
      ackSent = true; // 解決失敗でも再試行しない (連投防止)
    }

    // pending: retryAfterMs を尊重して sleep
    const wait = clampRetry(lastData.retryAfterMs);
    // deadline を超える sleep はしない (最後の polling を 1 回多く回すよりは即抜ける)
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(wait, remaining));
  }

  // timeout: 最後の pending を返す
  return { ...lastData, timedOut: true, pollCount };
}
