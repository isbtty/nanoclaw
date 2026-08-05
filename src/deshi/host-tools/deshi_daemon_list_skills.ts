/**
 * Handler: deshi daemon の `GET /skills` を叩いて、現在 nanoclaw に公開されている
 * skill 一覧を返す。
 *
 * HTTP path : POST /tools/deshi_daemon_list_skills
 *             POST /tools/deshi_daemon_refresh_skills (alias)
 * agent tool: mcp__deshi__daemon_list_skills
 *             mcp__deshi__daemon_refresh_skills
 *
 * 両者は HTTP 層では同じ handler を共有する (= deshi daemon が毎回 disk scan する
 * ため、bridge / daemon どちらにもキャッシュは持たない)。区別は agent 視点の
 * 意味付け (list は起動時 discover、refresh は実行時 re-fetch) で行う。
 *
 * 認証: deshi daemon の `GET /skills` は Bearer 必須 (auto-auth は POST /run 限定)。
 * したがって `DESHI_DAEMON_DEVICE_SECRET` 環境変数の Bearer を必須とする。
 */

import { MISSING_SECRET_MESSAGE, resolveDaemonEnv } from '../daemon-env.js';

export interface DaemonListSkillsResponse {
  ok: true;
  schemaVersion: number;
  skills: Array<{
    name: string;
    description: string;
    argumentHint?: string;
  }>;
}

export async function daemonListSkillsHandler(_body: unknown): Promise<DaemonListSkillsResponse> {
  const { url: deshiUrl, secret } = resolveDaemonEnv();
  if (!secret) {
    throw new Error(`${MISSING_SECRET_MESSAGE} on host-tools-server`);
  }

  const res = await fetch(`${deshiUrl}/skills`, {
    headers: { Authorization: `Bearer ${secret}:nanoclaw` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deshi daemon /skills failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    schemaVersion?: number;
    skills?: Array<{ name: string; description: string; argumentHint?: string }>;
  };

  if (typeof data.schemaVersion !== 'number' || !Array.isArray(data.skills)) {
    throw new Error(`deshi daemon /skills returned unexpected body: ${JSON.stringify(data)}`);
  }

  return {
    ok: true,
    schemaVersion: data.schemaVersion,
    skills: data.skills,
  };
}
