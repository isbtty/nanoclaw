/**
 * Handler: deshi daemon の `POST /gog` を叩いて、whitelist された `gog` CLI
 * サブコマンドを host 側で実行する。
 *
 * HTTP path : POST /tools/deshi_daemon_gog
 * agent tool: mcp__deshi__daemon_gog
 *
 * deshi 側の `/gog` skill は LLM dispatcher として 2 段 Claude session を消費
 * していた (nanoclaw agent → run_skill → secondary Claude → bash gog)。本 host-tool
 * は薄い HTTP wrapper として `POST /gog` を直接叩くので、agent から見ると
 * 1 ラウンドで完結する。安全策 (subcommand whitelist / `-a` 強制 injection /
 * 削除 / send 除外) は deshi 側 TS で deterministic に enforce されるので、
 * このラッパーは validation を厚くせず、daemon のエラー (400/403/502/504) を
 * agent に透過するだけにする (ADR-0009 primitive レイヤ責務)。
 *
 * 認証: deshi daemon の `/gog` は authed 配下なので Bearer 必須。
 */

export interface DaemonGogRequest {
  /** Dot-separated subcommand path (e.g. "calendar.events", "gmail.messages.list"). */
  subcommand: string;
  /** Additional CLI args to forward after the subcommand. Each element is one argv item. */
  args?: string[];
  /** Optional timeout override in ms. */
  timeout?: number;
}

export interface DaemonGogResponse {
  ok: true;
  subcommand: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function daemonGogHandler(body: unknown): Promise<DaemonGogResponse> {
  const req = validateRequest(body);

  const deshiUrl = process.env.DESHI_DAEMON_URL ?? 'http://localhost:3100';
  const secret = process.env.DESHI_DAEMON_DEVICE_SECRET;
  if (!secret) {
    throw new Error('DESHI_DAEMON_DEVICE_SECRET is not set on host-tools-server');
  }

  const res = await fetch(`${deshiUrl}/gog`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}:nanoclaw`,
    },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    // 4xx (whitelist violation / bad args / unconfigured) も 5xx (subprocess
    // failure / timeout) も agent には同じ Error として渡す。daemon 側が body
    // に subcommand / stderr / error メッセージを載せているので、それを含めて
    // 透過する。
    const text = await res.text();
    throw new Error(`deshi daemon /gog failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Partial<DaemonGogResponse> & { ok?: unknown };
  if (
    data.ok !== true ||
    typeof data.subcommand !== 'string' ||
    typeof data.stdout !== 'string' ||
    typeof data.stderr !== 'string' ||
    typeof data.exitCode !== 'number'
  ) {
    throw new Error(`deshi daemon /gog returned unexpected body: ${JSON.stringify(data)}`);
  }

  return {
    ok: true,
    subcommand: data.subcommand,
    stdout: data.stdout,
    stderr: data.stderr,
    exitCode: data.exitCode,
  };
}

function validateRequest(body: unknown): DaemonGogRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('request body must be a JSON object');
  }
  const r = body as Record<string, unknown>;

  if (typeof r.subcommand !== 'string' || r.subcommand.length === 0) {
    throw new Error('subcommand is required and must be a non-empty string');
  }

  const out: DaemonGogRequest = { subcommand: r.subcommand };

  if (r.args !== undefined && r.args !== null) {
    if (!Array.isArray(r.args) || !r.args.every((a) => typeof a === 'string')) {
      throw new Error('args must be a string array');
    }
    out.args = r.args as string[];
  }

  if (r.timeout !== undefined && r.timeout !== null) {
    if (typeof r.timeout !== 'number' || !Number.isFinite(r.timeout) || r.timeout < 1000 || r.timeout > 5 * 60_000) {
      throw new Error('timeout must be a number (ms) between 1000 and 300000');
    }
    out.timeout = r.timeout;
  }

  return out;
}
