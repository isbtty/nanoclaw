import { MISSING_SECRET_MESSAGE, resolveDaemonEnvWithDotenv } from './daemon-env.js';

/**
 * Mint a one-time knowledge-scope setup link from the deshi daemon's
 * `POST /knowledge/scope-link` (isbtty/deshi#396, Slice 5).
 *
 * Called from the channel-approval connect handler when a deshi-backed agent
 * group is wired to a new channel: we hand the owner a signed link that opens
 * deshi's scope-selection page for `channelId`. The daemon returns `{ url, token }`;
 * the token IS the credential (HMAC over channelId+exp+nonce, short-lived,
 * single-use) and the channelId is recovered from the signed token, never from
 * the page request — so the URL is safe to DM. We only relay the `url`.
 *
 * `channelId` must be the `<channel>:<platformId>` composite the deshi side
 * keys its scope store on (`daemon/src/routes/run.ts` composes the same shape
 * from channelContext), i.e. `${messagingGroup.channel_type}:${messagingGroup.platform_id}`.
 *
 * Auth + env resolution mirror {@link fetchDeshiDelegationFragment}: Bearer
 * `<secret>:nanoclaw`, with key/source precedence owned by
 * `resolveDaemonEnvWithDotenv` (see `daemon-env.ts`).
 */

export interface ScopeLink {
  url: string;
  token: string;
}

export async function fetchDeshiScopeLink(channelId: string, opts: { signal?: AbortSignal } = {}): Promise<ScopeLink> {
  const { url, secret } = resolveDaemonEnvWithDotenv();
  if (!secret) {
    throw new Error(`${MISSING_SECRET_MESSAGE} on host`);
  }

  const res = await fetch(`${url}/knowledge/scope-link`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}:nanoclaw`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channelId }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deshi daemon /knowledge/scope-link failed: ${res.status} ${text}`);
  }

  return (await res.json()) as ScopeLink;
}
