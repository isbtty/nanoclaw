import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getContainerConfig } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { fetchDeshiScopeLink } from '../../deshi/fetch-scope-link.js';
import { maybeDeliverScopeLink } from './channel-scope-link.js';
import { ensureUserDm } from './user-dm.js';

vi.mock('../../db/container-configs.js', () => ({ getContainerConfig: vi.fn() }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn() }));
vi.mock('../../deshi/fetch-scope-link.js', () => ({ fetchDeshiScopeLink: vi.fn() }));
vi.mock('./user-dm.js', () => ({ ensureUserDm: vi.fn() }));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: vi.fn() }));

const getContainerConfigMock = vi.mocked(getContainerConfig);
const getMessagingGroupMock = vi.mocked(getMessagingGroup);
const fetchScopeLinkMock = vi.mocked(fetchDeshiScopeLink);
const ensureUserDmMock = vi.mocked(ensureUserDm);
const getDeliveryAdapterMock = vi.mocked(getDeliveryAdapter);

// Minimal container-config row factory — only mcp_servers is read by the unit.
function configWith(mcpServers: Record<string, unknown>) {
  return { agent_group_id: 'ag-1', mcp_servers: JSON.stringify(mcpServers) } as ReturnType<typeof getContainerConfig>;
}

describe('maybeDeliverScopeLink', () => {
  beforeEach(() => {
    deliverMock.mockClear();
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock } as unknown as ReturnType<
      typeof getDeliveryAdapter
    >);
    getMessagingGroupMock.mockReturnValue({
      id: 'mg-1',
      channel_type: 'telegram',
      // Chat-SDK platform_id is already channel-namespaced.
      platform_id: 'telegram:-5146234415',
    } as ReturnType<typeof getMessagingGroup>);
    fetchScopeLinkMock.mockResolvedValue({
      url: 'https://u.deshi.jp/scope-ui?token=eyJ_a-b_c',
      token: 'eyJ_a-b_c',
    });
    ensureUserDmMock.mockResolvedValue({
      channel_type: 'line',
      platform_id: 'Uapprover',
    } as Awaited<ReturnType<typeof ensureUserDm>>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('boswell-backed group: keys the link by platform_id (no channel double-prefix) and DMs the approver the url', async () => {
    getContainerConfigMock.mockReturnValue(configWith({ boswell: { instructions: 'x' } }));

    await expect(maybeDeliverScopeLink('ag-1', 'mg-1', 'line:Uapprover')).resolves.toEqual({ ok: true });

    // platform_id verbatim — NOT `telegram:telegram:-5146234415` (isbtty/deshi#420).
    expect(fetchScopeLinkMock).toHaveBeenCalledWith('telegram:-5146234415');
    expect(ensureUserDmMock).toHaveBeenCalledWith('line:Uapprover');
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channelType, platformId, threadId, kind, content] = deliverMock.mock.calls[0];
    expect(channelType).toBe('line');
    expect(platformId).toBe('Uapprover');
    expect(threadId).toBeNull();
    expect(kind).toBe('chat-sdk');
    const text = JSON.parse(content as string).text as string;
    // `_` percent-encoded to `%5F` (survives Telegram markdown), `-` left as-is,
    // delivered as a bare (auto-linkable) URL — no code-span backticks.
    expect(text).toContain('https://u.deshi.jp/scope-ui?token=eyJ%5Fa-b%5Fc');
    expect(text).not.toContain('token=eyJ_a-b_c');
    expect(text).not.toContain('`');
  });

  it('legacy deshi-keyed group (pre-019): still gated in via the deshi fallback', async () => {
    getContainerConfigMock.mockReturnValue(configWith({ deshi: { instructions: 'x' } }));

    await expect(maybeDeliverScopeLink('ag-1', 'mg-1', 'line:Uapprover')).resolves.toEqual({ ok: true });
    expect(fetchScopeLinkMock).toHaveBeenCalledWith('telegram:-5146234415');
  });

  it('non-boswell group: skips entirely (no daemon call, no DM), returns not-deshi', async () => {
    getContainerConfigMock.mockReturnValue(configWith({ gmail: {} }));

    await expect(maybeDeliverScopeLink('ag-1', 'mg-1', 'line:Uapprover')).resolves.toEqual({
      ok: false,
      reason: 'not-deshi',
    });

    expect(fetchScopeLinkMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('no container config: skips entirely', async () => {
    getContainerConfigMock.mockReturnValue(undefined);

    await maybeDeliverScopeLink('ag-1', 'mg-1', 'line:Uapprover');

    expect(fetchScopeLinkMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('approver has no DM channel: mints link but does not deliver, returns no-dm', async () => {
    getContainerConfigMock.mockReturnValue(configWith({ deshi: {} }));
    ensureUserDmMock.mockResolvedValue(null);

    await expect(maybeDeliverScopeLink('ag-1', 'mg-1', 'line:Uapprover')).resolves.toEqual({
      ok: false,
      reason: 'no-dm',
    });

    expect(fetchScopeLinkMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('daemon call fails: swallows the error (best-effort), returns error, no DM', async () => {
    getContainerConfigMock.mockReturnValue(configWith({ deshi: {} }));
    fetchScopeLinkMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(maybeDeliverScopeLink('ag-1', 'mg-1', 'line:Uapprover')).resolves.toEqual({
      ok: false,
      reason: 'error',
    });

    expect(deliverMock).not.toHaveBeenCalled();
  });
});
