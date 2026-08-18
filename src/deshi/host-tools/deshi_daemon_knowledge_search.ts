/**
 * Handler: 知識検索BOT の検索窓口 (.deshi/adr/0021-bot-permission-split.md §4)。
 *
 * HTTP path : POST /tools/deshi_daemon_knowledge_search
 * agent tool: mcp__deshi__daemon_knowledge_search
 *
 * boswell の `POST /knowledge/search` を直接呼ぶ。返るのは引換ID (docId) と抜粋だけで、
 * 回答の作文は container 側の agent が行う。boswell 側で Claude を起動しないため、
 * job / polling / timeout の機構は持たない。
 *
 * 部屋の決定と fail-closed の理屈は {@link resolveKnowledgeRequest} 側に置いてある。
 *
 * Authorization は必須。boswell の auto-auth 免除は `body.channelContext` の有無で
 * 発火する (`daemon/src/middleware/auth.ts`) が、本エンドポイントが受けるのは
 * `channelId` なので免除されない。付け忘れると実行時に必ず 401 になる。
 */
import {
  BAD_REQUEST_ERROR,
  INDEX_UNAVAILABLE_ERROR,
  KNOWLEDGE_TIMEOUT_MS,
  resolveKnowledgeRequest,
} from './knowledge-request.js';

const UNAVAILABLE_ERROR = '知識検索を利用できませんでした';

export interface DaemonKnowledgeSearchRequest {
  query: string;
  senderToken: string;
  limit?: number;
}

export interface KnowledgeSearchResult {
  docId: string;
  name: string;
  score: number;
  snippet: string;
}
export type DaemonKnowledgeSearchResponse =
  | { ok: true; results: KnowledgeSearchResult[] }
  | { ok: false; error: string };

export async function daemonKnowledgeSearchHandler(body: unknown): Promise<DaemonKnowledgeSearchResponse> {
  const req = body as Partial<DaemonKnowledgeSearchRequest> | null;
  if (
    !req ||
    typeof req.query !== 'string' ||
    req.query.trim() === '' ||
    (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit <= 0))
  ) {
    return { ok: false, error: BAD_REQUEST_ERROR };
  }

  const context = resolveKnowledgeRequest(req.senderToken, UNAVAILABLE_ERROR);
  if (!context.ok) return context;

  try {
    const response = await fetch(`${context.url}/knowledge/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${context.secret}:nanoclaw`,
      },
      body: JSON.stringify({ channelId: context.channelId, query: req.query, limit: req.limit }),
      signal: AbortSignal.timeout(KNOWLEDGE_TIMEOUT_MS),
    });
    if (response.status === 503) return { ok: false, error: INDEX_UNAVAILABLE_ERROR };
    if (!response.ok) return { ok: false, error: UNAVAILABLE_ERROR };

    const data = (await response.json()) as { results?: unknown };
    if (!Array.isArray(data.results)) return { ok: false, error: UNAVAILABLE_ERROR };
    return { ok: true, results: data.results.map(pickResultFields) };
    // eslint-disable-next-line no-catch-all/no-catch-all -- 内部情報を返さず fail-closed にする
  } catch {
    return { ok: false, error: UNAVAILABLE_ERROR };
  }
}

/**
 * boswell が返した hit から、container に渡す分だけを取り出す。
 *
 * 素通しにすると、boswell が将来フィールドを足したとき (path 等) にそれがそのまま
 * 外部の人の居る部屋の agent へ抜ける。公開範囲を絞るための BOT なので、増えるときは
 * 明示的に足す側に倒す。
 */
function pickResultFields(hit: unknown): KnowledgeSearchResult {
  const h = (hit ?? {}) as Record<string, unknown>;
  return {
    docId: typeof h.docId === 'string' ? h.docId : '',
    name: typeof h.name === 'string' ? h.name : '',
    score: typeof h.score === 'number' ? h.score : 0,
    snippet: typeof h.snippet === 'string' ? h.snippet : '',
  };
}
