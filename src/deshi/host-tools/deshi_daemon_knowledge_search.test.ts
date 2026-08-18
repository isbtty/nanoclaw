import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { setPermissionSplitConfig } from '../permission-split.js';
import { issueSenderToken } from '../sender-token.js';
import { daemonKnowledgeSearchHandler } from './deshi_daemon_knowledge_search.js';

const fetchMock = vi.fn<typeof fetch>();

function now(): string {
  return new Date().toISOString();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function seedFixtures(): void {
  for (const [id, folder] of [
    ['ag-knowledge', 'knowledge-search'],
    ['ag-admin', 'admin'],
  ]) {
    createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
  }
  createMessagingGroup({
    id: 'mg-lab',
    channel_type: 'slack',
    platform_id: 'slack:C0123',
    name: 'lab',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  upsertUser({ id: 'slack:U1', kind: 'slack', display_name: 'Researcher', created_at: now() });
  for (const [id, agentGroupId, threadId] of [
    ['sess-knowledge', 'ag-knowledge', null],
    ['sess-admin', 'ag-admin', 'admin-thread'],
  ] as const) {
    createSession({
      id,
      agent_group_id: agentGroupId,
      messaging_group_id: 'mg-lab',
      thread_id: threadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
  }
  setPermissionSplitConfig({ knowledgeAgentGroupId: 'ag-knowledge', knowledgeInstance: 'slack-knowledge' });
}

function issueToken(agentGroupId = 'ag-knowledge', issuedAt?: Date): string {
  return issueSenderToken({
    userId: 'slack:U1',
    messagingGroupId: 'mg-lab',
    agentGroupId,
    sessionId: agentGroupId === 'ag-knowledge' ? 'sess-knowledge' : 'sess-admin',
    now: issuedAt,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  runMigrations(initTestDb());
  seedFixtures();
  vi.stubEnv('BOSWELL_DAEMON_URL', 'http://localhost:3100');
  vi.stubEnv('BOSWELL_DAEMON_DEVICE_SECRET', 'test-secret');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  closeDb();
});

describe('知識検索', () => {
  it('認証情報と登録済みのチャンネル識別子を送ること', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken(), limit: 5 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3100/knowledge/search',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret:nanoclaw' },
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({ channelId: 'slack:C0123', query: '質問', limit: 5 });
  });

  it('boswell が知らないフィールドを足しても、決めた項目しか返さないこと', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [{ docId: 'doc-1', name: '資料', score: 0.9, snippet: '抜粋', path: '/wiki/secret.md' }],
      }),
    );

    await expect(daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() })).resolves.toEqual({
      ok: true,
      results: [{ docId: 'doc-1', name: '資料', score: 0.9, snippet: '抜粋' }],
    });
  });

  it.each([
    ['質問が空', { query: '   ' }],
    ['件数の指定が数でない', { query: '質問', limit: 'たくさん' }],
    ['件数の指定が 0 以下', { query: '質問', limit: 0 }],
  ])('%s の場合、外部へ問い合わせないこと', async (_name, extra) => {
    const result = await daemonKnowledgeSearchHandler({ ...extra, senderToken: issueToken() });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('検索結果が一覧の形で返らなかった場合、成功として扱わないこと', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: 'なにか' }));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toBe(false);
  });

  it('boswell に繋がらない場合、成功として扱わないこと', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toBe(false);
  });

  it.each([
    ['存在しない token', () => 'unknown'],
    ['期限切れ token', () => issueToken('ag-knowledge', new Date('2000-01-01T00:00:00.000Z'))],
    ['token 無し', () => undefined],
    ['別の agent group の token', () => issueToken('ag-admin')],
  ])('%s の場合、外部へ問い合わせないこと', async (_label, token) => {
    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: token() });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('権限分離設定が無い場合、外部へ問い合わせないこと', async () => {
    getDb().prepare('DELETE FROM permission_split_config').run();

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('認証情報が無い場合、外部へ問い合わせないこと', async () => {
    vi.stubEnv('BOSWELL_DAEMON_DEVICE_SECRET', '');
    vi.stubEnv('DESHI_DAEMON_DEVICE_SECRET', '');

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('依頼元が別のチャンネルを指定しても無視すること', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await daemonKnowledgeSearchHandler({
      query: '質問',
      senderToken: issueToken(),
      channelId: 'slack:C9999',
      channelContext: { platformId: 'slack:C9999' },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string).channelId).toBe('slack:C0123');
  });

  it('検索基盤が利用できない場合、成功として扱わないこと', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'qmd is not installed' }, 503));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result).toEqual({
      ok: false,
      error: '知識検索の準備ができていません。しばらくしてから再度お試しください',
    });
  });
});
