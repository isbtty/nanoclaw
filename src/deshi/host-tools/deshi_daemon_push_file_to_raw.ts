/**
 * Handler: container 内 agent が受け取ったファイル (Telegram 添付等) を、
 * deshi daemon の `POST /files/upload` (ADR-0008) 経由で deshi-raw の
 * `inbox/<source>/` または `outputs/<slug>/` に push する。
 *
 * HTTP path : POST /tools/deshi_daemon_push_file_to_raw
 * agent tool: mcp__deshi__daemon_push_file_to_raw
 *
 * ## 役割
 *
 * ADR-0009 passthrough policy で nanoclaw 側に business state を残さない
 * ため、受信ファイルは即 deshi 側に転送する。本 host-tool は **転送のみ** を
 * 担い、要約・OCR・skill 実行はしない (skill 実行は `daemon_run_skill` の責務)。
 *
 * ## 入力 (MCP stdio 側から受ける JSON)
 *
 * MCP stdio (`container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts`) が
 * agent から `local_path` を受け、container 内でファイルを読み base64 化して
 * 本 handler に渡す。host-tools-server の MAX_BODY_BYTES = 20 MiB に収まる
 * ように MCP stdio 側で読み取り上限を制限する。
 *
 * - `file_b64`     : base64-encoded file content (必須)
 * - `dest_subpath` : `inbox/<source>/<date>/<filename>` 形式 (必須)
 * - `sha256`       : 64 文字 hex。MCP stdio 側で計算済み (必須)
 * - `source`       : `nanoclaw` 等 (任意、audit log 用)
 * - `overwrite`    : `outputs/` 上書きを許可するか (任意、default false)
 *
 * ## 認証
 *
 * deshi daemon `/files/upload` は Bearer 必須 (loopback 例外なし)。
 * `DESHI_DAEMON_DEVICE_SECRET` を本プロセスから付与する。
 *
 * ## エラー
 *
 * - 400 (`dest_subpath` 形式不正 / sha256 mismatch / 上書き禁止違反) は
 *   daemon が返すメッセージをそのまま透過する
 * - 409 `outputs/` 既存衝突は overwrite=true で再試行を agent に促す
 * - 413 (ファイルサイズ超過) は MCP stdio 側で事前に弾く方針だが、
 *   万一通った場合は daemon の 413 を透過する
 *
 * 仕様: ADR-0008 / ADR-0009、deshi PR #394。
 */

import { MISSING_SECRET_MESSAGE, resolveDaemonEnv } from '../daemon-env.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface DaemonPushFileToRawRequest {
  /** Base64-encoded file bytes. */
  file_b64: string;
  /** 保存先 path (`inbox/<source>/<date>/<file>` または `outputs/<slug>/<file>`)。 */
  dest_subpath: string;
  /** ファイル sha256 (64 文字 hex)。MCP stdio 側で計算する。 */
  sha256: string;
  /** audit log 用 source 名 (例: `nanoclaw`). */
  source?: string;
  /** `outputs/` 上書きを許可。 */
  overwrite?: boolean;
}

export interface DaemonPushFileToRawResponse {
  ok: true;
  /** 保存された相対 path (`raw/inbox/.../filename` 形式)。 */
  path: string;
  /** daemon が確認した sha256 (= 入力 sha256)。 */
  sha256: string;
  /** 書き込みバイト数。 */
  size: number;
  /** `created` / `skipped_same_sha` / `renamed_collision` / `overwritten` のいずれか。 */
  outcome: string;
}

export async function daemonPushFileToRawHandler(body: unknown): Promise<DaemonPushFileToRawResponse> {
  const req = validateRequest(body);

  const { url: deshiUrl, secret } = resolveDaemonEnv();
  if (!secret) {
    throw new Error(`${MISSING_SECRET_MESSAGE} on host-tools-server`);
  }

  const fileBytes = Buffer.from(req.file_b64, 'base64');
  if (fileBytes.length === 0) {
    throw new Error('file_b64 decoded to empty buffer');
  }

  // multipart/form-data を組み立てて deshi daemon に転送する。
  // node 18+ に内蔵の FormData / Blob を使うことで外部 dep を増やさない。
  const form = new FormData();
  form.append('dest_subpath', req.dest_subpath);
  form.append('sha256', req.sha256);
  if (req.source) form.append('source', req.source);
  if (req.overwrite === true) form.append('overwrite', 'true');
  // basename は dest_subpath 末尾を使う。fastify multipart で `file.filename` を
  // audit log に使うため、必ず非空である必要がある。
  const filename = req.dest_subpath.split('/').pop() ?? 'upload.bin';
  form.append('file', new Blob([fileBytes]), filename);

  const res = await fetch(`${deshiUrl}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}:nanoclaw` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deshi daemon /files/upload failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    ok?: boolean;
    path?: string;
    sha256?: string;
    size?: number;
    outcome?: string;
  };

  if (
    data.ok !== true ||
    typeof data.path !== 'string' ||
    typeof data.sha256 !== 'string' ||
    typeof data.size !== 'number' ||
    typeof data.outcome !== 'string'
  ) {
    throw new Error(`deshi daemon /files/upload returned unexpected body: ${JSON.stringify(data)}`);
  }

  return {
    ok: true,
    path: data.path,
    sha256: data.sha256,
    size: data.size,
    outcome: data.outcome,
  };
}

function validateRequest(body: unknown): DaemonPushFileToRawRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('request body must be a JSON object');
  }
  const r = body as Record<string, unknown>;

  if (typeof r.file_b64 !== 'string' || r.file_b64.length === 0) {
    throw new Error('file_b64 is required and must be a non-empty base64 string');
  }
  if (typeof r.dest_subpath !== 'string' || r.dest_subpath.length === 0) {
    throw new Error('dest_subpath is required and must be a non-empty string');
  }
  if (typeof r.sha256 !== 'string' || !SHA256_RE.test(r.sha256)) {
    throw new Error('sha256 must be a 64-character lowercase hex string');
  }

  let source: string | undefined;
  if (r.source !== undefined && r.source !== null) {
    if (typeof r.source !== 'string' || r.source.length === 0) {
      throw new Error('source must be a non-empty string when provided');
    }
    source = r.source;
  }

  let overwrite: boolean | undefined;
  if (r.overwrite !== undefined && r.overwrite !== null) {
    if (typeof r.overwrite !== 'boolean') {
      throw new Error('overwrite must be a boolean when provided');
    }
    overwrite = r.overwrite;
  }

  return {
    file_b64: r.file_b64,
    dest_subpath: r.dest_subpath,
    sha256: r.sha256,
    source,
    overwrite,
  };
}
