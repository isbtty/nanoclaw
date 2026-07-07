import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { pickApprover } from '../approvals/primitive.js';
import { maybeDeliverScopeLink } from './channel-scope-link.js';
import { hasAdminPrivilege } from './db/user-roles.js';
import { handleKnowledgeScopeCommand, KNOWLEDGE_SCOPE_COMMAND } from './knowledge-scope-command.js';

vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: vi.fn() }));
vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: vi.fn() }));
vi.mock('../approvals/primitive.js', () => ({ pickApprover: vi.fn() }));
vi.mock('./channel-scope-link.js', () => ({ maybeDeliverScopeLink: vi.fn() }));
vi.mock('./db/user-roles.js', () => ({ hasAdminPrivilege: vi.fn() }));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
const getDeliveryAdapterMock = vi.mocked(getDeliveryAdapter);
const getMessagingGroupMock = vi.mocked(getMessagingGroup);
const pickApproverMock = vi.mocked(pickApprover);
const maybeDeliverScopeLinkMock = vi.mocked(maybeDeliverScopeLink);
const hasAdminPrivilegeMock = vi.mocked(hasAdminPrivilege);

const baseInput = {
  userId: 'line:Uowner',
  agentGroupId: 'ag-1',
  messagingGroupId: 'mg-1',
  deliveryAddr: { channelType: 'line', platformId: 'line:group:C1', threadId: null },
};

function inputWith(text: string) {
  return { ...baseInput, content: JSON.stringify({ text }) };
}

/** Last reply text delivered to the channel, or undefined. */
function lastReplyText(): string | undefined {
  const call = deliverMock.mock.calls.at(-1);
  if (!call) return undefined;
  return JSON.parse(call[4] as string).text as string;
}

describe('handleKnowledgeScopeCommand', () => {
  beforeEach(() => {
    deliverMock.mockClear();
    getDeliveryAdapterMock.mockReturnValue({ deliver: deliverMock } as unknown as ReturnType<
      typeof getDeliveryAdapter
    >);
    getMessagingGroupMock.mockReturnValue({
      name: 'テストグループ',
      platform_id: 'line:group:C1',
    } as ReturnType<typeof getMessagingGroup>);
    pickApproverMock.mockReturnValue(['telegram:Owner']);
    hasAdminPrivilegeMock.mockReturnValue(true);
    maybeDeliverScopeLinkMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('non-command message: returns false, does nothing', async () => {
    const handled = await handleKnowledgeScopeCommand(inputWith('こんにちは'));
    expect(handled).toBe(false);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(maybeDeliverScopeLinkMock).not.toHaveBeenCalled();
  });

  it('matches the slash command case-insensitively and with trailing args', async () => {
    const handled = await handleKnowledgeScopeCommand(inputWith(`${KNOWLEDGE_SCOPE_COMMAND.toUpperCase()} extra`));
    expect(handled).toBe(true);
    expect(maybeDeliverScopeLinkMock).toHaveBeenCalledWith('ag-1', 'mg-1', 'line:Uowner');
  });

  it('matches the skill name typed directly (with/without slash and deshi- prefix)', async () => {
    for (const text of ['deshi-update-knowledge-scope', '/deshi-update-knowledge-scope', 'update-knowledge-scope']) {
      maybeDeliverScopeLinkMock.mockClear();
      const handled = await handleKnowledgeScopeCommand(inputWith(text));
      expect(handled, text).toBe(true);
      expect(maybeDeliverScopeLinkMock, text).toHaveBeenCalledTimes(1);
    }
  });

  it('matches when the bot is @mentioned before the command (Slack/Discord group case)', async () => {
    // mention-required groups arrive as `<@Ubot> update-knowledge-scope` (or a
    // labelled `<@Ubot|bot>` / generic `@bot`). The leading mention must not
    // break the exact-match. (isbtty/deshi#511)
    for (const text of [
      '<@Ubot> update-knowledge-scope',
      '<@Ubot|dou-team-boswell> update-knowledge-scope',
      '@dou-team-boswell update-knowledge-scope',
      '<@Ubot>  /update-knowledge-scope extra',
    ]) {
      maybeDeliverScopeLinkMock.mockClear();
      const handled = await handleKnowledgeScopeCommand(inputWith(text));
      expect(handled, text).toBe(true);
      expect(maybeDeliverScopeLinkMock, text).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT match natural language — that is the deshi delegation fragment’s job', async () => {
    for (const text of ['公開範囲を編集したい', '公開範囲弄りたい', '知識スコープを変更したい', '今日は天気がいいね']) {
      const handled = await handleKnowledgeScopeCommand(inputWith(text));
      expect(handled, text).toBe(false);
      expect(maybeDeliverScopeLinkMock, text).not.toHaveBeenCalled();
    }
  });

  it('owner: mints + DMs the link and acks in-channel', async () => {
    const handled = await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    expect(handled).toBe(true);
    expect(maybeDeliverScopeLinkMock).toHaveBeenCalledWith('ag-1', 'mg-1', 'line:Uowner');
    expect(lastReplyText()).toContain('DM または管理者用チャンネルに送りました');
  });

  it('non-owner: forwards the request to the owner DM (with context), requester gets a link-free ack', async () => {
    hasAdminPrivilegeMock.mockReturnValue(false);
    const handled = await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    expect(handled).toBe(true);
    // Minted for the OWNER, not the requester, with a context preamble (4th arg).
    expect(maybeDeliverScopeLinkMock).toHaveBeenCalledTimes(1);
    const [ag, mg, recipient, preamble] = maybeDeliverScopeLinkMock.mock.calls[0];
    expect([ag, mg, recipient]).toEqual(['ag-1', 'mg-1', 'telegram:Owner']);
    expect(preamble).toContain('テストグループ');
    expect(preamble).toContain('line:Uowner');
    // Requester ack carries no link.
    expect(lastReplyText()).toContain('オーナーに転送');
    expect(lastReplyText()).not.toContain('http');
  });

  it('non-owner with a display name: shows the name (and id) in the forwarded context', async () => {
    hasAdminPrivilegeMock.mockReturnValue(false);
    const input = { ...baseInput, content: JSON.stringify({ text: KNOWLEDGE_SCOPE_COMMAND, senderName: '大槻' }) };
    await handleKnowledgeScopeCommand(input);
    const preamble = maybeDeliverScopeLinkMock.mock.calls[0][3];
    expect(preamble).toContain('大槻さん');
    expect(preamble).toContain('line:Uowner');
  });

  it('no channel name: forwarded context shows platform + group/DM (e.g. LINEグループ)', async () => {
    hasAdminPrivilegeMock.mockReturnValue(false);
    getMessagingGroupMock.mockReturnValue({
      name: null,
      channel_type: 'line',
      is_group: 1,
    } as ReturnType<typeof getMessagingGroup>);
    await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    const preamble = maybeDeliverScopeLinkMock.mock.calls[0][3];
    expect(preamble).toContain('LINEグループ');
  });

  it('null sender: still forwards to the owner (unidentified requester)', async () => {
    const handled = await handleKnowledgeScopeCommand({ ...inputWith(KNOWLEDGE_SCOPE_COMMAND), userId: null });
    expect(handled).toBe(true);
    expect(hasAdminPrivilegeMock).not.toHaveBeenCalled();
    expect(maybeDeliverScopeLinkMock).toHaveBeenCalledWith(
      'ag-1',
      'mg-1',
      'telegram:Owner',
      expect.stringContaining('不明な送信者'),
    );
  });

  it('non-owner with no owner configured: cannot forward, tells requester', async () => {
    hasAdminPrivilegeMock.mockReturnValue(false);
    pickApproverMock.mockReturnValue([]);
    await handleKnowledgeScopeCommand(inputWith(KNOWLEDGE_SCOPE_COMMAND));
    expect(maybeDeliverScopeLinkMock).not.toHaveBeenCalled();
    expect(lastReplyText()).toContain('管理者が設定されていない');
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
