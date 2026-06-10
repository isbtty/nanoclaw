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
  /**
   * 自由文 input（ADR-0009 deshi_run_start）。ユーザー発話をそのまま、または
   * skill 名が明確なら "/deshi-<skill> <args>" を渡す。deshi 側 POST /run が
   * skill 解決 + 非同期実行する（旧 5-skill 限定 allowlist は廃止）。
   */
  input: string;
  channelContext: ChannelContext;
}

export interface DaemonRunSkillResponse {
  ok: true;
  jobId: string;
  threadId: string;
}

export async function daemonRunSkillHandler(body: unknown): Promise<DaemonRunSkillResponse> {
  const req = body as DaemonRunSkillRequest;
  if (!req || typeof req.input !== 'string' || req.input.trim() === '' || !req.channelContext) {
    throw new Error('daemonRunSkill: input and channelContext are required');
  }

  const deshiUrl = process.env.DESHI_DAEMON_URL ?? 'http://localhost:3100';

  const res = await fetch(`${deshiUrl}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: req.input,
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
