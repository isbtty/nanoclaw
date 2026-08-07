import { MISSING_SECRET_MESSAGE, resolveDaemonEnvWithDotenv } from './daemon-env.js';

/**
 * Fetch the boswell MCP delegation policy fragment from boswell daemon's
 * `GET /nanoclaw-fragment` (isbtty/deshi#319, #322).
 *
 * Called from `claude-md-compose.ts` at group spawn time when the group's
 * `mcp_servers` includes `boswell`. The returned markdown becomes the body
 * of `.claude-fragments/mcp-boswell.md`, which is imported by the group's
 * CLAUDE.md. The boswell side re-reads its source file on every call, so
 * editing `<boswell-repo>/.boswell/nanoclaw-delegation.md` takes effect on
 * the next spawn without restarting either daemon.
 *
 * Not registered as an MCP tool — the agent never needs to call this.
 * It is host-internal, used only by the host process during compose.
 *
 * Auth: Bearer matches the host-tools-server pattern (`<secret>:nanoclaw`).
 *
 * Env resolution: `resolveDaemonEnvWithDotenv` (see `daemon-env.ts`) — `process.env`
 * first, then a `.env` fallback. The fallback matters because the launchd-spawned
 * host process does not inherit the interactive shell env and the dynamically
 * generated `com.nanoclaw-v2-<slug>` plist carries only PATH/HOME — so without it
 * the device secret lives only in `.env` and this throws, dropping the delegation
 * fragment. Reading `.env` here removes the need for any plist injection.
 */

export async function fetchDeshiDelegationFragment(opts: { signal?: AbortSignal } = {}): Promise<string> {
  const { url, secret } = resolveDaemonEnvWithDotenv();
  if (!secret) {
    throw new Error(`${MISSING_SECRET_MESSAGE} on host`);
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
