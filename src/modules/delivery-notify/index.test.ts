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
  requestApproval: vi.fn(async (..._args: unknown[]) => true),
  deliver: vi.fn(async (..._args: unknown[]) => 'plat'),
  pickApprover: vi.fn((..._args: unknown[]) => ['telegram:owner']),
  pickApprovalDelivery: vi.fn(async (..._args: unknown[]) => ({
    userId: 'telegram:owner',
    messagingGroup: { channel_type: 'telegram', platform_id: 'telegram:owner' },
  })),
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
  pickApprover: h.pickApprover,
  pickApprovalDelivery: h.pickApprovalDelivery,
  registerApprovalHandler: (_action: string, handler: (ctx: unknown) => Promise<void>) => {
    h.approvalHandler = handler;
  },
}));
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

  it('releases the cooldown when the card fails to send, so the next dead-letter re-alerts', async () => {
    h.requestApproval.mockResolvedValueOnce(false); // first card fails to deliver
    await h.deadLetterCb!(event({ agentGroupId: 'ag-fail', errName: 'AuthenticationError' }));
    // Cooldown was released → a second dead-letter of the same class alerts again
    // instead of being suppressed for the full cooldown window.
    await h.deadLetterCb!(event({ agentGroupId: 'ag-fail', errName: 'AuthenticationError' }));
    expect(h.requestApproval).toHaveBeenCalledTimes(2);
  });
});

describe('delivery-notify — approval handler', () => {
  it('runs /deshi-feedback-gh routed to the re-derived owner DM on approve', async () => {
    await h.approvalHandler!({
      session: { agent_group_id: 'ag-1' },
      payload: { reason: 'permanent', errorClass: 'ValidationError', channelType: 'telegram', messageId: 'out-1' },
      decision: 'approve',
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/run$/);
    const body = JSON.parse((opts as any).body);
    // Routed through deshi-general (exposed to nanoclaw), which orchestrates
    // feedback-gh (not exposed → can't be /run directly).
    expect(body.input).toContain('/deshi-general');
    expect(body.input).toContain('/deshi-feedback-gh');
    expect(body.input).toContain('ValidationError');
    expect(body.input).toContain('out-1');
    // Output routed to the owner DM (from pickApprovalDelivery), not a bare userId.
    expect(body.channelContext.platformId).toBe('telegram:owner');
  });

  it('on /run failure, reports to the owner DM (not the agent session)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 502 } as never);
    await h.approvalHandler!({
      session: { agent_group_id: 'ag-1' },
      payload: { reason: 'permanent', errorClass: 'ValidationError', channelType: 'telegram', messageId: 'out-1' },
      decision: 'approve',
    });

    // The status line is delivered to the owner DM via the delivery adapter,
    // never through the agent's session (which would surface in a customer chat).
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const call = h.deliver.mock.calls[0]!;
    expect(call[1]).toBe('telegram:owner'); // platformId arg
    expect(JSON.parse(call[4] as string).text).toContain('起動に失敗');
  });

  it('skips the skill run when no approver DM is reachable', async () => {
    h.pickApprovalDelivery.mockResolvedValueOnce(null as never);
    await h.approvalHandler!({
      session: { agent_group_id: 'ag-1' },
      payload: { reason: 'permanent', errorClass: 'ValidationError', channelType: 'telegram', messageId: 'out-1' },
      decision: 'approve',
    });

    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('on reject, acknowledges to the owner DM and does not run the skill', async () => {
    await h.approvalHandler!({
      session: { agent_group_id: 'ag-1' },
      payload: { reason: 'permanent', errorClass: 'ValidationError', channelType: 'telegram', messageId: 'out-1' },
      decision: 'reject',
    });

    // No investigation run on reject.
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // Reject acknowledgment goes to the owner DM, not the agent session.
    expect(h.deliver).toHaveBeenCalledTimes(1);
    const call = h.deliver.mock.calls[0]!;
    expect(call[1]).toBe('telegram:owner');
    expect(JSON.parse(call[4] as string).text).toContain('却下');
  });
});
