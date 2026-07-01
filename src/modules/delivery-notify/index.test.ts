/**
 * Unit tests for the delivery-notify module (isbtty/deshi#491, 段2).
 * External collaborators (core delivery hook, approvals, user-dm, deshi /run)
 * are mocked; we assert the module's own behavior: owner alert, storm
 * suppression, best-effort apology, internal-traffic skip, and the approve →
 * /deshi-feedback-gh wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  deadLetterCb: null as null | ((ev: unknown) => Promise<void>),
  approvalHandler: null as null | ((ctx: unknown) => Promise<void>),
  requestApproval: vi.fn(async (..._args: unknown[]) => {}),
  deliver: vi.fn(async (..._args: unknown[]) => 'plat'),
  ensureUserDm: vi.fn(async () => ({ channel_type: 'telegram', platform_id: 'telegram:owner' })),
  getAgentGroup: vi.fn(() => ({ name: 'Test Agent' })),
}));

vi.mock('../../delivery.js', () => ({
  onDeadLetter: (cb: (ev: unknown) => Promise<void>) => {
    h.deadLetterCb = cb;
  },
  getDeliveryAdapter: () => ({ deliver: h.deliver }),
}));
vi.mock('../approvals/primitive.js', () => ({
  requestApproval: h.requestApproval,
  registerApprovalHandler: (_action: string, handler: (ctx: unknown) => Promise<void>) => {
    h.approvalHandler = handler;
  },
}));
vi.mock('../permissions/user-dm.js', () => ({ ensureUserDm: h.ensureUserDm }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: h.getAgentGroup }));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Import for side effects — the module registers onDeadLetter + the approval
// handler at import time, capturing them into `h` via the mocks above.
import './index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function event(overrides: Record<string, any> = {}): any {
  const err = Object.assign(new Error('bad'), { name: overrides.errName ?? 'ValidationError' });
  return {
    session: { id: 'sess-1', agent_group_id: overrides.agentGroupId ?? 'ag-1', messaging_group_id: 'mg-1' },
    msg: {
      id: 'out-1',
      kind: overrides.kind ?? 'chat',
      channel_type: overrides.channelType ?? 'telegram',
      platform_id: 'telegram:123',
      thread_id: null,
      timestamp: '',
      content: '',
      in_reply_to: null,
    },
    reason: 'permanent',
    err,
  };
}

beforeEach(() => {
  h.requestApproval.mockClear();
  h.deliver.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (..._args: unknown[]) => ({ ok: true, json: async () => ({}) })),
  );
});

describe('delivery-notify — onDeadLetter', () => {
  it('alerts the owner and apologizes to the chat on a user-facing dead-letter', async () => {
    await h.deadLetterCb!(event({ agentGroupId: 'ag-alert', errName: 'ValidationError' }));

    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    const arg = h.requestApproval.mock.calls[0]![0] as any;
    expect(arg.action).toBe('investigate_delivery_failure');
    expect(arg.payload.errorClass).toBe('ValidationError');
    expect(arg.question).toContain('ValidationError');

    // Best-effort apology delivered to the failed chat.
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const apology = JSON.parse(h.deliver.mock.calls[0]![4] as string);
    expect(apology.text).toContain('お届けできませんでした');
  });

  it('suppresses a storm: same (agent group + error class) within cooldown sends one card', async () => {
    await h.deadLetterCb!(event({ agentGroupId: 'ag-storm', errName: 'PermissionError' }));
    await h.deadLetterCb!(event({ agentGroupId: 'ag-storm', errName: 'PermissionError' }));
    await h.deadLetterCb!(event({ agentGroupId: 'ag-storm', errName: 'PermissionError' }));

    expect(h.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not notify for internal agent-to-agent traffic', async () => {
    await h.deadLetterCb!(event({ agentGroupId: 'ag-int', channelType: 'agent' }));
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });
});

describe('delivery-notify — approval handler', () => {
  it('runs /deshi-feedback-gh with the failure summary on approve', async () => {
    const notify = vi.fn();
    await h.approvalHandler!({
      payload: { reason: 'permanent', errorClass: 'ValidationError', channelType: 'telegram', messageId: 'out-1' },
      userId: 'telegram:owner',
      notify,
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/run$/);
    const body = JSON.parse((opts as any).body);
    expect(body.input).toContain('/deshi-feedback-gh');
    expect(body.input).toContain('ValidationError');
    expect(body.input).toContain('out-1');
    expect(body.channelContext.platformId).toBe('telegram:owner');
  });

  it('skips the skill run when the approver has no reachable DM', async () => {
    h.ensureUserDm.mockResolvedValueOnce(null as never);
    const notify = vi.fn();
    await h.approvalHandler!({
      payload: { reason: 'permanent', errorClass: 'ValidationError', channelType: 'telegram', messageId: 'out-1' },
      userId: 'telegram:nobody',
      notify,
    });

    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('DM 宛先'));
  });
});
