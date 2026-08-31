/**
 * Handler: 検索で得た docId の本文を、同じ公開範囲から読み取る
 * (.deshi/adr/0021-bot-permission-split.md §4)。
 *
 * HTTP path : POST /tools/deshi_daemon_knowledge_read
 * agent tool: mcp__deshi__daemon_knowledge_read
 *
 * 部屋の決定と Authorization の要否は search 側と同じ。理屈は
 * {@link resolveKnowledgeRequest} を参照。
 */
import { BAD_REQUEST_ERROR, KNOWLEDGE_TIMEOUT_MS, resolveKnowledgeRequest } from './knowledge-request.js';

const UNAVAILABLE_ERROR = '知識の読み取りを利用できませんでした';
const NOT_FOUND_ERROR = 'その資料は見つかりませんでした';

export interface DaemonKnowledgeReadRequest {
  docId: string;
  senderToken: string;
}

export type DaemonKnowledgeReadResponse = { ok: true; name: string; content: string } | { ok: false; error: string };

export async function daemonKnowledgeReadHandler(body: unknown): Promise<DaemonKnowledgeReadResponse> {
  const req = body as Partial<DaemonKnowledgeReadRequest> | null;
  if (!req || typeof req.docId !== 'string' || req.docId.trim() === '') {
    return { ok: false, error: BAD_REQUEST_ERROR };
  }

  const context = resolveKnowledgeRequest(req.senderToken, UNAVAILABLE_ERROR);
  if (!context.ok) return context;

  try {
    const response = await fetch(`${context.url}/knowledge/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${context.secret}:nanoclaw`,
      },
      body: JSON.stringify({ channelId: context.channelId, docId: req.docId }),
      signal: AbortSignal.timeout(KNOWLEDGE_TIMEOUT_MS),
    });
    // 403 (公開範囲外) と 404 (そんな docId は無い) を区別して見せない。区別できると
    // 範囲外に何が在るかの手がかりになる。
    if (response.status === 403 || response.status === 404) return { ok: false, error: NOT_FOUND_ERROR };
    if (!response.ok) return { ok: false, error: UNAVAILABLE_ERROR };

    const data = (await response.json()) as { name?: string; content?: string };
    return typeof data.name === 'string' && typeof data.content === 'string'
      ? { ok: true, name: data.name, content: data.content }
      : { ok: false, error: UNAVAILABLE_ERROR };
    // eslint-disable-next-line no-catch-all/no-catch-all -- 内部情報を返さず fail-closed にする
  } catch {
    return { ok: false, error: UNAVAILABLE_ERROR };
  }
}
