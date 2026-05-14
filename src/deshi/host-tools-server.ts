/**
 * deshi Host Tools Server
 *
 * macOS / Linux host 上で動く HTTP server。container 内の MCP stdio server から
 * host.docker.internal 経由で呼ばれ、各 tool handler に dispatch する。
 *
 * tool handler は src/deshi/host-tools/ 配下に handler ごとのファイルとして
 * 分割配置し、src/deshi/host-tools/index.ts の barrel に登録する。
 *
 * ルーティング:
 *   POST /tools/<name> → handlers[<name>] を呼び出し
 *   GET  /health       → handlers.health を呼び出し (curl からの疎通確認用)
 *
 * Env:
 *   DESHI_HOST_TOOLS_PORT (default: 5180)
 *
 * 起動 (host の Node ランタイム):
 *   pnpm exec tsx src/deshi/host-tools-server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { handlers } from './host-tools/index.js';

const PORT = parseInt(process.env.DESHI_HOST_TOOLS_PORT ?? '5180', 10);

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`[deshi-host-tools ${ts}] ${msg}`);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
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
  log(`registered handlers: ${Object.keys(handlers).join(', ')}`);
});
