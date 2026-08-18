import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
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
  createAgentGroup({
    id: 'ag-knowledge',
    name: 'Knowledge Search',
    folder: 'knowledge-search',
    agent_provider: null,
    created_at: now(),
  });
  createAgentGroup({
    id: 'ag-admin',
    name: 'Admin',
    folder: 'admin',
    agent_provider: null,
    created_at: now(),
  });
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
  createSession({
    id: 'sess-knowledge',
    agent_group_id: 'ag-knowledge',
    messaging_group_id: 'mg-lab',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  createSession({
    id: 'sess-admin',
    agent_group_id: 'ag-admin',
    messaging_group_id: 'mg-lab',
    thread_id: 'admin-thread',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  closeDb();
});

describe('知識検索', () => {
  it('有効な部屋から質問した場合、登録済みのチャンネル識別子をそのまま使うこと', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: '回答' }));

    await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      input: '/boswell-knowledge-search 質問',
      channelContext: { channel: 'slack', platformId: 'slack:C0123', threadId: null },
    });
  });

  it('知識検索が完了した場合、回答本文を返すこと', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: '公開情報の回答' }));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result).toEqual({ ok: true, answer: '公開情報の回答' });
  });

  it('身に覚えのない依頼の場合、外部へ問い合わせないこと', async () => {
    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: 'unknown' });

    expect(result).toEqual({ ok: false, error: 'この部屋からの質問として確認できませんでした' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('期限を過ぎた依頼の場合、外部へ問い合わせないこと', async () => {
    const result = await daemonKnowledgeSearchHandler({
      query: '質問',
      senderToken: issueToken('ag-knowledge', new Date('2000-01-01T00:00:00.000Z')),
    });

    expect(result.ok).toEqual(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('依頼元を確認できない場合、外部へ問い合わせないこと', async () => {
    const result = await daemonKnowledgeSearchHandler({ query: '質問' });

    expect(result.ok).toEqual(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('管理者BOTからの依頼の場合、外部へ問い合わせないこと', async () => {
    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken('ag-admin') });

    expect(result.ok).toEqual(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('権限分離運用でない場合、外部へ問い合わせないこと', async () => {
    const { getDb } = await import('../../db/connection.js');
    getDb().prepare('DELETE FROM permission_split_config').run();

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toEqual(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('知識検索処理が失敗した場合、回答成功として扱わないこと', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: 'failed' }));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toEqual(false);
  });

  it('知識検索が時間内に終わらない場合、待機を打ち切ること', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, 202)).mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-08-17T00:03:00.000Z'));
      return jsonResponse({ status: 'pending' });
    });

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result).toEqual({ ok: false, error: '時間がかかっています。答えが出たらこのチャンネルに投稿されます' });
  });

  it('依頼元が別のチャンネルを指定しても、登録済みの部屋だけを使うこと', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: '回答' }));

    await daemonKnowledgeSearchHandler({
      query: '質問',
      senderToken: issueToken(),
      channelId: 'slack:C9999',
      channelContext: { channel: 'slack', platformId: 'slack:C9999' },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string).channelContext).toEqual({
      channel: 'slack',
      platformId: 'slack:C0123',
      threadId: null,
    });
  });

  it('依頼が受け付けられなかった場合、回答成功として扱わないこと', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, 400));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toEqual(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('受付番号が返らなかった場合、待機に入らないこと', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 202));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toEqual(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('進捗を確認できなくなった場合、待ち続けないこと', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, 202))
      .mockResolvedValueOnce(jsonResponse({ error: 'job not found' }, 404));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toEqual(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('完了したのに本文が無い場合、回答成功として扱わないこと', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed' }));

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toEqual(false);
  });

  it('boswell への認証情報が無い場合、外部へ問い合わせないこと', async () => {
    vi.stubEnv('BOSWELL_DAEMON_DEVICE_SECRET', '');
    vi.stubEnv('DESHI_DAEMON_DEVICE_SECRET', '');

    const result = await daemonKnowledgeSearchHandler({ query: '質問', senderToken: issueToken() });

    expect(result.ok).toEqual(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
