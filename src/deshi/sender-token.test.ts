import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup } from '../db/messaging-groups.js';
import { createSession } from '../db/sessions.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import {
  issueSenderToken,
  resolveSenderToken,
  stampSenderToken,
  sweepExpiredSenderTokens,
  SENDER_TOKEN_TTL_MS,
} from './sender-token.js';

function now() {
  return new Date().toISOString();
}

/** 発行に必要な参照先 (発言者・チャンネル・ワークスペース・セッション) を揃える。 */
function seedFixtures() {
  createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C1',
    name: 'lab',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  upsertUser({ id: 'slack:U1', kind: 'slack', display_name: 'Researcher', created_at: now() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
}

function issueFor(overrides: { now?: Date } = {}) {
  return issueSenderToken({
    userId: 'slack:U1',
    messagingGroupId: 'mg-1',
    agentGroupId: 'ag-1',
    sessionId: 'sess-1',
    ...overrides,
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seedFixtures();
});

afterEach(() => {
  closeDb();
});

describe('sender token', () => {
  describe('発行と引き当て', () => {
    it('発行したトークンから、発言者とチャンネルを引き当てられること', () => {
      const token = issueFor();

      expect(resolveSenderToken(token)).toEqual({
        token,
        user_id: 'slack:U1',
        messaging_group_id: 'mg-1',
        agent_group_id: 'ag-1',
        session_id: 'sess-1',
        issued_at: expect.any(String),
        expires_at: expect.any(String),
      });
    });

    it('発行のたびに異なるトークンになること', () => {
      const tokens = new Set([issueFor(), issueFor(), issueFor()]);

      expect(tokens.size).toEqual(3);
    });

    it('同じトークンを何度でも引き当てられること（1つの依頼が複数の操作に分かれても通る）', () => {
      const token = issueFor();

      expect(resolveSenderToken(token)?.user_id).toEqual('slack:U1');
      expect(resolveSenderToken(token)?.user_id).toEqual('slack:U1');
      expect(resolveSenderToken(token)?.user_id).toEqual('slack:U1');
    });
  });

  describe('引き当てに失敗する場合', () => {
    it('身に覚えのないトークンでは、誰の依頼か分からないものとして扱うこと', () => {
      issueFor();

      expect(resolveSenderToken('not-a-real-token')).toBeNull();
    });

    it('トークンが空のときは、誰の依頼か分からないものとして扱うこと', () => {
      expect(resolveSenderToken('')).toBeNull();
    });

    it('期限を過ぎたトークンでは、誰の依頼か分からないものとして扱うこと', () => {
      const issuedAt = new Date('2026-08-07T00:00:00.000Z');
      const token = issueFor({ now: issuedAt });

      const justExpired = new Date(issuedAt.getTime() + SENDER_TOKEN_TTL_MS);
      expect(resolveSenderToken(token, justExpired)).toBeNull();
    });

    it('期限内であれば引き当てられること（期限判定の境界）', () => {
      const issuedAt = new Date('2026-08-07T00:00:00.000Z');
      const token = issueFor({ now: issuedAt });

      const justBefore = new Date(issuedAt.getTime() + SENDER_TOKEN_TTL_MS - 1);
      expect(resolveSenderToken(token, justBefore)?.user_id).toEqual('slack:U1');
    });
  });

  describe('期限切れの掃除', () => {
    it('期限切れだけを消し、生きているトークンは残すこと', () => {
      const old = new Date('2026-08-07T00:00:00.000Z');
      const expiredToken = issueFor({ now: old });
      const liveToken = issueFor({ now: new Date(old.getTime() + SENDER_TOKEN_TTL_MS) });

      const removed = sweepExpiredSenderTokens(new Date(old.getTime() + SENDER_TOKEN_TTL_MS + 1));

      expect(removed).toEqual(1);
      expect(resolveSenderToken(expiredToken, new Date(old.getTime() + SENDER_TOKEN_TTL_MS + 1))).toBeNull();
      expect(resolveSenderToken(liveToken, new Date(old.getTime() + SENDER_TOKEN_TTL_MS + 1))?.user_id).toEqual(
        'slack:U1',
      );
    });

    it('消す対象が無いときは 0 件を返すこと', () => {
      issueFor();

      expect(sweepExpiredSenderTokens()).toEqual(0);
    });
  });

  describe('参照先が消えたとき', () => {
    it('セッションを削除しても止められず、トークンも道連れで消えること', async () => {
      const token = issueFor();
      const { getDb } = await import('../db/connection.js');

      expect(() => getDb().prepare('DELETE FROM sessions WHERE id = ?').run('sess-1')).not.toThrow();
      expect(resolveSenderToken(token)).toBeNull();
    });

    it('ユーザーを削除しても止められないこと', async () => {
      issueFor();
      const { getDb } = await import('../db/connection.js');

      expect(() => getDb().prepare('DELETE FROM users WHERE id = ?').run('slack:U1')).not.toThrow();
    });
  });

  describe('メッセージへの差し込み', () => {
    const ctx = {
      userId: 'slack:U1',
      messagingGroupId: 'mg-1',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
    };

    it('発言者が分かるとき、そのメッセージから発言者を引けるようになること', () => {
      const stamped = JSON.parse(stampSenderToken(JSON.stringify({ text: 'こんにちは' }), ctx));

      expect(resolveSenderToken(stamped.senderToken)).toEqual(
        expect.objectContaining({
          user_id: 'slack:U1',
          messaging_group_id: 'mg-1',
          agent_group_id: 'ag-1',
          session_id: 'sess-1',
        }),
      );
    });

    it('元のメッセージの中身を壊さないこと', () => {
      const stamped = JSON.parse(
        stampSenderToken(JSON.stringify({ text: 'こんにちは', senderId: 'U1', sender: 'Researcher' }), ctx),
      );

      expect(stamped).toEqual({
        text: 'こんにちは',
        senderId: 'U1',
        sender: 'Researcher',
        senderToken: expect.any(String),
      });
    });

    it('発言者を特定できないときは、メッセージに何も足さないこと', () => {
      const original = JSON.stringify({ text: 'こんにちは' });

      const result = stampSenderToken(original, { ...ctx, userId: null });

      expect(result).toEqual(original);
      expect(sweepExpiredSenderTokens(new Date('2099-01-01T00:00:00.000Z'))).toEqual(0);
    });

    it('メッセージが JSON でないときは、そのまま素通しすること', () => {
      expect(stampSenderToken('just a string', ctx)).toEqual('just a string');
    });

    it('メッセージが JSON でもオブジェクトでないときは、そのまま素通しすること', () => {
      expect(stampSenderToken('[1,2,3]', ctx)).toEqual('[1,2,3]');
    });
  });
});
