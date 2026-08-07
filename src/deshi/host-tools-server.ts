/**
 * deshi Host Tools Server
 *
 * macOS / Linux host 上で動く HTTP server。2 系統の handler を 1 プロセスで
 * dispatch する:
 *
 *   1. **MCP-backed handlers** (`src/deshi/host-tools/`, snake_case)
 *      container 内の MCP stdio server から host.docker.internal 経由で呼ばれる
 *      内部経路。loopback 前提なので無認証。命名規則は ADR-0009。
 *
 *   2. **Direct HTTP receivers (inbound)** (`src/deshi/inbound/`, kebab-case)
 *      deshi daemon 等の外部システムからの push を受ける外部経路。
 *      Bearer <BOSWELL_DAEMON_DEVICE_SECRET> で dispatch 一括認証。命名規則は
 *      ADR-0010。
 *
 * ルーティング:
 *   POST /tools/<name>                   → MCP-backed handlers[<name>]
 *   POST /inbound/deshi/<name>           → inboundHandlers[<name>] (Bearer 必須)
 *   GET  /health                         → handlers.health (curl 用)
 *
 * Env:
 *   DESHI_HOST_TOOLS_PORT      (default: 5180)
 *   DESHI_HOST_TOOLS_BIND      (default: 127.0.0.1) — listen する bind address。
 *                               macOS の Docker Desktop は host.docker.internal を
 *                               loopback に流すため 127.0.0.1 で container から届くが、
 *                               Linux docker は host-gateway(bridge IP)経由になるため
 *                               127.0.0.1 bind だと container から到達できない。
 *                               Linux デプロイでは 0.0.0.0 を設定する(Bearer 認証必須 +
 *                               閉域前提)。
 *   BOSWELL_DAEMON_DEVICE_SECRET (inbound endpoint の Bearer secret。未設定なら
 *                               inbound は常に 401。MCP-backed handler 用には
 *                               別途 daemon_poll_until_done でも使われる。
 *                               旧名 DESHI_DAEMON_DEVICE_SECRET も互換で読む
 *                               — 解決順は daemon-env.ts 参照)
 *
 * 起動 (host の Node ランタイム):
 *   pnpm exec tsx src/deshi/host-tools-server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { initDb } from '../db/index.js';
import { MISSING_SECRET_MESSAGE, resolveDaemonEnv } from './daemon-env.js';
import { handlers } from './host-tools/index.js';
import { inboundHandlers } from './inbound/index.js';
import { InboundHandlerError } from './inbound/errors.js';

const PORT = parseInt(process.env.DESHI_HOST_TOOLS_PORT ?? '5180', 10);
// Default 127.0.0.1 keeps macOS/dev safe; Linux deploys set 0.0.0.0 so
// containers can reach the bridge gateway (see Env doc above).
const BIND_HOST = process.env.DESHI_HOST_TOOLS_BIND ?? '127.0.0.1';

/**
 * central DB (`data/v2.db`) を本プロセス内で init する (ADR-0010 §7)。
 *
 * inbound handler は getMessagingGroupByPlatform / resolveSession 等を介して
 * central DB を読み書きするため、host-tools-server プロセスでも独自に
 * `initDb()` を呼んでおく必要がある。host 本体 (`src/index.ts`) とは別
 * プロセスで起動するため、host 本体の init は引き継がれない。
 *
 * migrations は実行しない: schema 反映は host 本体側で既に走っている前提。
 * host-tools-server 側で重複 migrate を走らせると不要な race を引き起こす。
 *
 * SQLite WAL モード (`initDb` 内で設定) で multi-reader / single-writer を
 * 確保しているため、host 本体と同じ DB ファイルを同時に握って問題ない。
 */
initDb(path.join(DATA_DIR, 'v2.db'));

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`[deshi-host-tools ${ts}] ${msg}`);
}

/**
 * inbound endpoint で添付ファイルを base64 inline で受ける運用と、
 * daemon_push_file_to_raw が base64 化したファイルを転送する運用を想定し、
 * 150 MiB まで許容する。超過時は途中で接続を切って reject する。
 * これは deshi-mcp-stdio.ts の MAX_PUSH_FILE_BYTES (100 MiB raw) を base64
 * (≈1.37x = ~133 MiB) + JSON キーで包んだサイズに収まるよう対で決めている。
 * 上限値は両用途で共有。
 */
const MAX_BODY_BYTES = 150 * 1024 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function dispatch(name: string, body: unknown, res: ServerResponse): Promise<void> {
  const handler = handlers[name];
  if (!handler) {
    jsonResponse(res, 404, { ok: false, error: `unknown handler: ${name}` });
    return;
  }
  try {
    const result = await handler(body);
    jsonResponse(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`handler ${name} failed: ${message}`);
    jsonResponse(res, 500, { ok: false, error: message });
  }
}

/**
 * inbound endpoint の Bearer secret 検証 (timing-safe)。
 *
 * `Authorization: Bearer <secret>` ヘッダの secret 部分を
 * 解決済みの device secret (daemon-env.ts) と byte-wise に比較する。
 * 長さが違う / secret 未設定 / Bearer 形式違反は早期 false。
 *
 * `timingSafeEqual` は長さが違う Buffer に対して throw するため、
 * 事前に長さ比較で揃える。
 */
function verifyInboundBearer(authHeader: string | undefined): boolean {
  // deshi → boswell リネーム移行中: boswell daemon は BOSWELL_DAEMON_DEVICE_SECRET
  // を Bearer に載せる想定だが、移行未完環境では旧 DESHI_DAEMON_DEVICE_SECRET
  // だけが export されている。両方を受け付けて配信を落とさない (boswell #664)。
  const expected = resolveDaemonEnv().secret ?? '';
  if (expected.length === 0) return false;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice('Bearer '.length);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'utf-8'), Buffer.from(expected, 'utf-8'));
}

/**
 * inbound HTTP receiver の dispatch (ADR-0010)。
 *
 * 認証は本関数の冒頭で一括検証 (handler ごとの個別 check はしない)。
 * 認証 / handler 解決 / 例外を JSON で応答する。
 * InboundHandlerError は handler が status を選んで投げる例外で、その
 * status をそのまま HTTP response に伝える。他の例外は 500 として包む。
 */
async function dispatchInbound(name: string, body: unknown, res: ServerResponse): Promise<void> {
  const handler = inboundHandlers[name];
  if (!handler) {
    jsonResponse(res, 404, { ok: false, error: `unknown inbound handler: ${name}` });
    return;
  }
  try {
    const result = await handler(body);
    jsonResponse(res, 200, result);
  } catch (err) {
    if (err instanceof InboundHandlerError) {
      log(`inbound handler ${name} returned ${err.status}: ${err.message}`);
      jsonResponse(res, err.status, { ok: false, error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`inbound handler ${name} failed: ${message}`);
    jsonResponse(res, 500, { ok: false, error: message });
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  // GET /health — curl などからの簡易疎通確認 (handlers.health と同じ結果)
  if (req.method === 'GET' && url.pathname === '/health') {
    log('GET /health');
    await dispatch('health', {}, res);
    return;
  }

  // POST /tools/<name> — MCP stdio server からの転送先
  if (req.method === 'POST' && url.pathname.startsWith('/tools/')) {
    const name = url.pathname.slice('/tools/'.length);
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    log(`POST /tools/${name}`);
    await dispatch(name, body, res);
    return;
  }

  // POST /inbound/{boswell,deshi}/<name> — 外部システム (boswell daemon 等) からの push
  // ADR-0010 に基づく direct HTTP receiver 系統。Bearer 認証必須。
  // deshi → boswell リネーム (boswell #664) 移行中は両 prefix を受け付ける。
  // boswell daemon は現在 /inbound/boswell/ に push するが、旧 fork / 未移行
  // 環境は /inbound/deshi/ を叩くため互換を維持する。
  const inboundPrefix = ['/inbound/boswell/', '/inbound/deshi/'].find((p) => url.pathname.startsWith(p));
  if (req.method === 'POST' && inboundPrefix) {
    if (!verifyInboundBearer(req.headers.authorization)) {
      log(`POST ${url.pathname} 401 unauthorized`);
      jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const name = url.pathname.slice(inboundPrefix.length);
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    log(`POST ${inboundPrefix}${name}`);
    await dispatchInbound(name, body, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// long polling 対応: deshi_daemon_poll_until_done は最大 30 分かかるため、
// Node default の requestTimeout (300s) / headersTimeout を無制限化する。
// 必要なら handler 側で timeoutMs を尊重して切る。
server.requestTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, BIND_HOST, () => {
  log(`listening on http://${BIND_HOST}:${PORT}`);
  log(`registered handlers (MCP-backed): ${Object.keys(handlers).join(', ')}`);
  log(`registered handlers (inbound): ${Object.keys(inboundHandlers).join(', ')}`);
  if (!resolveDaemonEnv().secret) {
    log(`WARNING: ${MISSING_SECRET_MESSAGE} — /inbound/{boswell,deshi}/* will always return 401`);
  }
});
