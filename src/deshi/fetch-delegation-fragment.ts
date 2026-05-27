/**
 * Fetch the deshi MCP delegation policy fragment from deshi daemon's
 * `GET /nanoclaw-fragment` (isbtty/deshi#319, #322).
 *
 * Called from `claude-md-compose.ts` at group spawn time when the group's
 * `mcp_servers` includes `deshi`. The returned markdown becomes the body
 * of `.claude-fragments/mcp-deshi.md`, which is imported by the group's
 * CLAUDE.md. The deshi side re-reads its source file on every call, so
 * editing `<deshi-repo>/.deshi/nanoclaw-delegation.md` takes effect on
 * the next spawn without restarting either daemon.
 *
 * Not registered as an MCP tool — the agent never needs to call this.
 * It is host-internal, used only by the host process during compose.
 *
 * Auth: Bearer matches the host-tools-server pattern (`<secret>:nanoclaw`).
 */

const DEFAULT_DAEMON_URL = 'http://localhost:3100';

export async function fetchDeshiDelegationFragment(opts: { signal?: AbortSignal } = {}): Promise<string> {
  const url = process.env.DESHI_DAEMON_URL ?? DEFAULT_DAEMON_URL;
  const secret = process.env.DESHI_DAEMON_DEVICE_SECRET;
  if (!secret) {
    throw new Error('DESHI_DAEMON_DEVICE_SECRET is not set on host');
  }

  const res = await fetch(`${url}/nanoclaw-fragment`, {
    headers: { Authorization: `Bearer ${secret}:nanoclaw` },
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deshi daemon /nanoclaw-fragment failed: ${res.status} ${text}`);
  }

  return res.text();
}
