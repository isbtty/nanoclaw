/**
 * Health check handler.
 *
 * bridge 自身の生存確認用。`mcp__deshi__health` (container 内 agent から)
 * と `GET /health` (curl 等から) の両方が同じ結果を返す。
 *
 * 命名規則は ADR-0009 / .deshi/docs/mcp-tool-naming.md 参照。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HealthResponse {
  ok: true;
  version: string;
  uptime: number;
  timestamp: string;
  handlers: string[];
}

function loadVersion(): string {
  try {
    // package.json は repo ルートに 1 つだけ。
    // 本ファイル: src/deshi/host-tools/health.ts → ../../../package.json
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * health handler factory。
 *
 * `Object.keys(handlers)` を返したいが、handlers 自身に health が含まれるため
 * `import './index.js'` だと ESM 初期化順序で `handlers` が空オブジェクトに
 * 見えるタイミングがある。barrel 側から `createHealthHandler(handlerNames)` で
 * 呼ぶことで初期化順序問題を回避する。
 */
export function createHealthHandler(getHandlerNames: () => string[]): (body: unknown) => Promise<HealthResponse> {
  const version = loadVersion();
  return async function healthHandler(_body: unknown): Promise<HealthResponse> {
    return {
      ok: true,
      version,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      handlers: getHandlerNames(),
    };
  };
}
