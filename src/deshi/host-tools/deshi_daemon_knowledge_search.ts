/**
 * Handler: 知識検索BOT 専用の窓口 (.deshi/adr/0019-bot-permission-split.md §4)。
 *
 * HTTP path : POST /tools/deshi_daemon_knowledge_search
 * agent tool: mcp__deshi__daemon_knowledge_search
 *
 * boswell の `/boswell-knowledge-search` に固定で投げる。skill 名を引数にしないのは、
 * この BOT に skill 実行の口を一切持たせないため。
 *
 * ## channelId を引数で受け取らない
 *
 * 知識検索BOT の部屋には外部の人が居る。channelId を引数にすると、prompt injection
 * で「別の部屋の id で検索しろ」と言わせるだけで他ルームの知識が読める。boswell 側の
 * scope は channelId をキーに引かれる (`daemon/src/routes/run.ts`) ので、ここが
 * そのまま公開範囲の決定点になる。
 *
 * そのため部屋は container の申告ではなく **sender token から host 側で解決する**
 * (ADR-0020)。token は host が inbound の各メッセージに打刻したもので、container は
 * 自分の部屋のものしか持っていない。偽造すれば解決できず、本物を使えば自分の部屋に
 * 解決される。`channelId` / `channelContext` を body に混ぜても読まない。
 *
 * ## fail-closed
 *
 * 解決できない・期限切れ・知識検索BOT 以外の agent group の token・権限分離運用でない
 * host — いずれも **boswell に問い合わせる前に**断る。疑わしい要求を一度でも通すと
 * 公開範囲外の知識が返る側に倒れるため、判断を後段に委ねない。
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { resolveDaemonEnv } from '../daemon-env.js';
import { getPermissionSplitConfig } from '../permission-split.js';
import { resolveSenderToken } from '../sender-token.js';

const POLL_INTERVAL_MS = Number(process.env.DESHI_KNOWLEDGE_POLL_INTERVAL_MS ?? 2000);
const TIMEOUT_MS = Number(process.env.DESHI_KNOWLEDGE_TIMEOUT_MS ?? 180000);

const UNVERIFIED_ROOM_ERROR = 'この部屋からの質問として確認できませんでした';
const UNAVAILABLE_ERROR = '知識検索を利用できませんでした';
const TIMEOUT_ERROR = '時間内に答えられませんでした';

export interface DaemonKnowledgeSearchRequest {
  query: string;
  senderToken: string;
}

export type DaemonKnowledgeSearchResponse = { ok: true; answer: string } | { ok: false; error: string };

interface JobStatusResponse {
  status: 'pending' | 'completed' | 'failed';
  result?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function daemonKnowledgeSearchHandler(body: unknown): Promise<DaemonKnowledgeSearchResponse> {
  const req = body as Partial<DaemonKnowledgeSearchRequest> | null;
  if (!req || typeof req.query !== 'string' || req.query.trim() === '' || typeof req.senderToken !== 'string') {
    return { ok: false, error: UNVERIFIED_ROOM_ERROR };
  }

  const config = getPermissionSplitConfig();
  if (!config) return { ok: false, error: UNAVAILABLE_ERROR };

  const sender = resolveSenderToken(req.senderToken);
  if (!sender || sender.agent_group_id !== config.knowledge_agent_group_id) {
    return { ok: false, error: UNVERIFIED_ROOM_ERROR };
  }

  const messagingGroup = getMessagingGroup(sender.messaging_group_id);
  if (!messagingGroup) return { ok: false, error: UNVERIFIED_ROOM_ERROR };

  const { url, secret } = resolveDaemonEnv();
  if (!secret) return { ok: false, error: UNAVAILABLE_ERROR };

  const deadline = Date.now() + TIMEOUT_MS;
  try {
    const runResponse = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: `/boswell-knowledge-search ${req.query}`,
        channelContext: {
          channel: messagingGroup.channel_type,
          platformId: messagingGroup.platform_id,
          threadId: null,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (runResponse.status !== 202) return { ok: false, error: UNAVAILABLE_ERROR };

    const runData = (await runResponse.json()) as { jobId?: string };
    if (!runData.jobId) return { ok: false, error: UNAVAILABLE_ERROR };

    while (Date.now() < deadline) {
      const jobResponse = await fetch(`${url}/jobs/${runData.jobId}`, {
        headers: { Authorization: `Bearer ${secret}:nanoclaw` },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!jobResponse.ok) return { ok: false, error: UNAVAILABLE_ERROR };

      const job = (await jobResponse.json()) as JobStatusResponse;
      if (job.status === 'completed') {
        return typeof job.result === 'string'
          ? { ok: true, answer: job.result }
          : { ok: false, error: UNAVAILABLE_ERROR };
      }
      if (job.status === 'failed') return { ok: false, error: UNAVAILABLE_ERROR };

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- 例外の中身に関わらず「答えない」に倒す
  } catch {
    return { ok: false, error: Date.now() >= deadline ? TIMEOUT_ERROR : UNAVAILABLE_ERROR };
  }

  return { ok: false, error: TIMEOUT_ERROR };
}
