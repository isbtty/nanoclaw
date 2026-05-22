/**
 * Handler: deshi daemon の `POST /run` を叩いて 202 + jobId を返す。
 *
 * HTTP path : POST /tools/deshi_daemon_run_skill
 * agent tool: mcp__deshi__daemon_run_skill
 *
 * deshi daemon は `127.0.0.1` + `channelContext != null` の組み合わせで
 * auto-auth (deviceId="nanoclaw") するため、本 handler は Authorization
 * ヘッダを付けない。
 *
 * 詳細仕様: isbtty/deshi#199 工程 5 / ADR-0009。
 */

interface ChannelContext {
  channel: string;
  platformId: string;
  threadId?: string;
}

export interface DaemonRunSkillRequest {
  /** 例: "sync" (NANOCLAW_SKILL_ALLOWLIST に含まれる 5 個のみ daemon 側で許可) */
  skillName: string;
  /** 例: "--full" */
  args?: string;
  channelContext: ChannelContext;
}

export interface DaemonRunSkillResponse {
  ok: true;
  jobId: string;
  threadId: string;
}

export async function daemonRunSkillHandler(body: unknown): Promise<DaemonRunSkillResponse> {
  const req = body as DaemonRunSkillRequest;
  if (!req || typeof req.skillName !== 'string' || !req.channelContext) {
    throw new Error('daemonRunSkill: skillName and channelContext are required');
  }

  const deshiUrl = process.env.DESHI_DAEMON_URL ?? 'http://localhost:3100';
  const input = req.args ? `/${req.skillName} ${req.args}` : `/${req.skillName}`;

  const res = await fetch(`${deshiUrl}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input,
      channelContext: req.channelContext,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deshi daemon /run failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { jobId?: string; threadId?: string };
  if (!data.jobId || !data.threadId) {
    throw new Error(`deshi daemon /run returned unexpected body: ${JSON.stringify(data)}`);
  }
  return { ok: true, jobId: data.jobId, threadId: data.threadId };
}
