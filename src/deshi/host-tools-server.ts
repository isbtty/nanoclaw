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
 *      Bearer <DESHI_DAEMON_DEVICE_SECRET> で dispatch 一括認証。命名規則は
 *      ADR-0010。
 *
 * ルーティング:
 *   POST /tools/<name>                   → MCP-backed handlers[<name>]
 *   POST /inbound/deshi/<name>           → inboundHandlers[<name>] (Bearer 必須)
 *   GET  /health                         → handlers.health (curl 用)
 *
 * Env:
 *   DESHI_HOST_TOOLS_PORT      (default: 5180)
 *   DESHI_DAEMON_DEVICE_SECRET (inbound endpoint の Bearer secret。未設定なら
 *                               inbound は常に 401。MCP-backed handler 用には
 *                               別途 daemon_poll_until_done でも使われる)
 *
 * 起動 (host の Node ランタイム):
 *   pnpm exec tsx src/deshi/host-tools-server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { handlers } from './host-tools/index.js';
import { inboundHandlers } from './inbound/index.js';
import { InboundHandlerError } from './inbound/errors.js';

const PORT = parseInt(process.env.DESHI_HOST_TOOLS_PORT ?? '5180', 10);

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`[deshi-host-tools ${ts}] ${msg}`);
}

/**
 * inbound endpoint で添付ファイルを base64 inline で受ける運用を想定し、
 * 20 MiB まで許容する。超過時は途中で接続を切って reject する。
 * MCP-backed handler 側は元々こんなに大きい body を投げないため、
 * 上限値は共有で問題なし。
 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

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
 * `DESHI_DAEMON_DEVICE_SECRET` と byte-wise に比較する。
 * 長さが違う / secret 未設定 / Bearer 形式違反は早期 false。
 *
 * `timingSafeEqual` は長さが違う Buffer に対して throw するため、
 * 事前に長さ比較で揃える。
 */
function verifyInboundBearer(authHeader: string | undefined): boolean {
  const expected = process.env.DESHI_DAEMON_DEVICE_SECRET ?? '';
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

  // POST /inbound/deshi/<name> — 外部システム (deshi daemon 等) からの push
  // ADR-0010 に基づく direct HTTP receiver 系統。Bearer 認証必須。
  if (req.method === 'POST' && url.pathname.startsWith('/inbound/deshi/')) {
    if (!verifyInboundBearer(req.headers.authorization)) {
      log(`POST ${url.pathname} 401 unauthorized`);
      jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const name = url.pathname.slice('/inbound/deshi/'.length);
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      jsonResponse(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    log(`POST /inbound/deshi/${name}`);
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

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`registered handlers (MCP-backed): ${Object.keys(handlers).join(', ')}`);
  log(`registered handlers (inbound): ${Object.keys(inboundHandlers).join(', ')}`);
  if ((process.env.DESHI_DAEMON_DEVICE_SECRET ?? '').length === 0) {
    log('WARNING: DESHI_DAEMON_DEVICE_SECRET is not set — /inbound/deshi/* will always return 401');
  }
});
