/**
 * Handler: deshi daemon の `GET /files/search` を叩いて、deshi-wiki / deshi-raw
 * 配下のファイルをハイブリッド検索 (semantic + lexical via `qmd` CLI) する。
 *
 * HTTP path : POST /tools/deshi_daemon_search_files
 * agent tool: mcp__deshi__daemon_search_files
 *
 * skill (`mcp__deshi__daemon_run_skill`) は workflow 単位なので「ちょっと当たり
 * 調べたい」用途には spawn overhead が重い。本 host-tool は薄い HTTP wrapper
 * として primitive な検索を直接提供することで、agent が 1 ターンで複数回
 * 叩いて探索する用途を高速化する (ADR-0009 host-tools 命名規則準拠)。
 *
 * 認証: deshi daemon の `/files/search` は Bearer 必須 (authed 配下にマウント)。
 * したがって `BOSWELL_DAEMON_DEVICE_SECRET` (旧名 `DESHI_DAEMON_DEVICE_SECRET` も可) の Bearer を必須とする。
 *
 * Daemon 側エラーコード対応:
 *   - 503 + `qmd is not installed on server` → 運用機に qmd CLI が未インストール
 *   - 503 + `indexing: true` → 索引構築中。少し待って再試行を agent に促す
 *   - 400 → query 空文字。本 handler でも事前に弾く
 */

import { MISSING_SECRET_MESSAGE, resolveDaemonEnv } from '../daemon-env.js';

export interface DaemonSearchFilesRequest {
  /** 検索クエリ (必須、非空)。日本語 OK。 */
  query: string;
  /** 結果上限 (default 20、daemon 側のデフォルトと揃える)。1〜100。 */
  limit?: number;
}

export interface DaemonSearchFilesResult {
  /** ファイルの相対パス (wiki/raw 配下、起点は dataDir)。 */
  path: string;
  /** ファイル名 (basename)。 */
  name: string;
  /** ハイブリッドスコア (高いほど近い)。 */
  score: number;
  /** マッチ箇所のスニペット (`.md` 等の場合)。バイナリでは空文字。 */
  snippet: string;
}

export interface DaemonSearchFilesResponse {
  ok: true;
  /** 入力クエリ (エコー)。daemon 側で正規化される場合に備えて常に返す。 */
  query: string;
  results: DaemonSearchFilesResult[];
  /** 結果件数 (results.length と一致するが、daemon 側ペイロードに合わせて保持)。 */
  totalCount: number;
  /** 索引タイムスタンプ (ISO 8601)。索引の鮮度を agent が判断する材料。 */
  indexedAt: string;
}

export async function daemonSearchFilesHandler(body: unknown): Promise<DaemonSearchFilesResponse> {
  const req = validateRequest(body);

  const { url: deshiUrl, secret } = resolveDaemonEnv();
  if (!secret) {
    throw new Error(`${MISSING_SECRET_MESSAGE} on host-tools-server`);
  }

  const params = new URLSearchParams({ q: req.query });
  if (req.limit !== undefined) params.set('limit', String(req.limit));

  const res = await fetch(`${deshiUrl}/files/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${secret}:nanoclaw` },
  });

  if (!res.ok) {
    const text = await res.text();
    // 503 系のメッセージは daemon が JSON で返している (qmd 未インストール /
    // 索引構築中)。本文をそのままエラーに含めて agent 側で見えるようにする。
    throw new Error(`deshi daemon /files/search failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    query?: string;
    results?: unknown;
    totalCount?: number;
    indexedAt?: string;
  };

  if (
    typeof data.query !== 'string' ||
    !Array.isArray(data.results) ||
    typeof data.totalCount !== 'number' ||
    typeof data.indexedAt !== 'string'
  ) {
    throw new Error(`deshi daemon /files/search returned unexpected body: ${JSON.stringify(data)}`);
  }

  // 個別 result の shape は daemon を信頼してそのまま流す (将来 daemon 側に
  // フィールド追加された場合の前方互換のため、ここで stripping しない)。
  return {
    ok: true,
    query: data.query,
    results: data.results as DaemonSearchFilesResult[],
    totalCount: data.totalCount,
    indexedAt: data.indexedAt,
  };
}

function validateRequest(body: unknown): DaemonSearchFilesRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('request body must be a JSON object');
  }
  const r = body as Record<string, unknown>;

  if (typeof r.query !== 'string' || r.query.trim().length === 0) {
    throw new Error('query is required and must be a non-empty string');
  }

  let limit: number | undefined;
  if (r.limit !== undefined && r.limit !== null) {
    if (typeof r.limit !== 'number' || !Number.isInteger(r.limit) || r.limit < 1 || r.limit > 100) {
      throw new Error('limit must be an integer between 1 and 100');
    }
    limit = r.limit;
  }

  return { query: r.query, limit };
}
