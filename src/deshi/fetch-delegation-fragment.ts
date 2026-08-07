import { readEnvFile } from '../env.js';

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
 * Env resolution: `process.env` first, then a `.env` fallback via `readEnvFile`
 * (same pattern as `config.ts`). The fallback matters because the launchd-spawned
 * host process does not inherit the interactive shell env and the dynamically
 * generated `com.nanoclaw-v2-<slug>` plist carries only PATH/HOME — so without it
 * `DESHI_DAEMON_DEVICE_SECRET` lives only in `.env` and this throws, dropping the
 * delegation fragment. Reading `.env` here removes the need for any plist injection.
 */

const DEFAULT_DAEMON_URL = 'http://localhost:3100';

export async function fetchDeshiDelegationFragment(opts: { signal?: AbortSignal } = {}): Promise<string> {
  const envConfig = readEnvFile(['DESHI_DAEMON_URL', 'DESHI_DAEMON_DEVICE_SECRET']);
  const url = process.env.DESHI_DAEMON_URL || envConfig.DESHI_DAEMON_URL || DEFAULT_DAEMON_URL;
  const secret = process.env.DESHI_DAEMON_DEVICE_SECRET || envConfig.DESHI_DAEMON_DEVICE_SECRET;
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
