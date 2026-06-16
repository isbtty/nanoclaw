import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeOutboundDirect } from '../../session-manager.js';
import { maybeDeliverScopeLink } from './channel-scope-link.js';
import { hasAdminPrivilege } from './db/user-roles.js';
import { handleKnowledgeScopeCommand, KNOWLEDGE_SCOPE_COMMAND } from './knowledge-scope-command.js';

vi.mock('../../session-manager.js', () => ({ writeOutboundDirect: vi.fn() }));
vi.mock('./channel-scope-link.js', () => ({ maybeDeliverScopeLink: vi.fn() }));
vi.mock('./db/user-roles.js', () => ({ hasAdminPrivilege: vi.fn() }));

const writeOutboundDirectMock = vi.mocked(writeOutboundDirect);
const maybeDeliverScopeLinkMock = vi.mocked(maybeDeliverScopeLink);
const hasAdminPrivilegeMock = vi.mocked(hasAdminPrivilege);

const baseInput = {
  userId: 'line:Uowner',
  agentGroupId: 'ag-1',
  messagingGroupId: 'mg-1',
  sessionId: 'sess-1',
  deliveryAddr: { channelType: 'line', platformId: 'line:group:C1', threadId: null },
};

function inputWith(text: string) {
  return { ...baseInput, content: JSON.stringify({ text }) };
}

/** Last reply text written to the channel, or undefined. */
function lastReplyText(): string | undefined {
  const call = writeOutboundDirectMock.mock.calls.at(-1);
  if (!call) return undefined;
  return JSON.parse(call[2].content).text as string;
}

describe('handleKnowledgeScopeCommand', () => {
  beforeEach(() => {
    hasAdminPrivilegeMock.mockReturnValue(true);
    maybeDeliverScopeLinkMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('non-command message: returns false, does nothing', async () => {
    const handled = await handleKnowledgeScopeCommand(inputWith('こんにちは'));
    expect(handled).toBe(false);
    expect(writeOutboundDirectMock).not.toHaveBeenCalled();
    expect(maybeDeliverScopeLinkMock).not.toHaveBeenCalled();
  });

  it('matches the command case-insensitively and with trailing args', async () => {
    const handled = await handleKnowledgeScopeCommand(inputWith(`${KNOWLEDGE_SCOPE_COMMAND.toUpperCase()} extra`));
    expect(handled).toBe(true);
    expect(maybeDeliverScopeLinkMock).toHaveBeenCalledWith('ag-1', 'mg-1', 'line:Uowner');
  });

  it('owner: mints + DMs the link and acks in-channel', async () => {
    const handled = await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    expect(handled).toBe(true);
    expect(maybeDeliverScopeLinkMock).toHaveBeenCalledWith('ag-1', 'mg-1', 'line:Uowner');
    expect(lastReplyText()).toContain('DM に送りました');
  });

  it('non-owner: denied, no mint', async () => {
    hasAdminPrivilegeMock.mockReturnValue(false);
    const handled = await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    expect(handled).toBe(true);
    expect(maybeDeliverScopeLinkMock).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain('オーナー');
  });

  it('null sender: denied', async () => {
    const handled = await handleKnowledgeScopeCommand({ ...inputWith(KNOWLEDGE_SCOPE_COMMAND), userId: null });
    expect(handled).toBe(true);
    expect(hasAdminPrivilegeMock).not.toHaveBeenCalled();
    expect(maybeDeliverScopeLinkMock).not.toHaveBeenCalled();
  });

  it('non-deshi group: tells the owner it is unsupported', async () => {
    maybeDeliverScopeLinkMock.mockResolvedValue({ ok: false, reason: 'not-deshi' });
    await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    expect(lastReplyText()).toContain('対応していません');
  });

  it('no DM: tells the owner to DM the bot first', async () => {
    maybeDeliverScopeLinkMock.mockResolvedValue({ ok: false, reason: 'no-dm' });
    await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    expect(lastReplyText()).toContain('DM 宛先');
  });

  it('mint error: reports failure', async () => {
    maybeDeliverScopeLinkMock.mockResolvedValue({ ok: false, reason: 'error' });
    await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    expect(lastReplyText()).toContain('失敗');
  });
});
