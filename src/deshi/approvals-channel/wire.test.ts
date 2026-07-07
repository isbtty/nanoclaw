/**
 * deshi#517 — routeApprovalsToChannel（案D 配線ヘルパ）のテスト。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getUserDm } from '../../modules/permissions/db/user-dms.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import { routeApprovalsToChannel } from './wire.js';

function now(): string {
  return new Date().toISOString();
}

function seedUser(id: string, kind: string): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

function seedOwner(id: string): void {
  seedUser(id, 'slack');
  grantRole({ user_id: id, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
}

function seedGlobalAdmin(id: string, kind = 'slack'): void {
  seedUser(id, kind);
  grantRole({ user_id: id, role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('routeApprovalsToChannel', () => {
  it('creates the shared messaging_group as a delivery-only group (is_group=1, strict, denied_at set)', () => {
    seedOwner('slack:UOWNER');

    const res = routeApprovalsToChannel({ platformId: 'C0SHARED', name: '承認' });

    expect(res.created).toBe(true);
    // platform_id は adapter エンコード形式（slack:）で保存される（deshi#528）。
    const mg = getMessagingGroupByPlatform('slack', 'slack:C0SHARED');
    expect(mg).toBeDefined();
    expect(mg?.platform_id).toBe('slack:C0SHARED');
    expect(mg?.is_group).toBe(1);
    expect(mg?.unknown_sender_policy).toBe('strict');
    // denied_at を立てて router の channel 登録 escalation を確実に殺す（配信は妨げない）。
    expect(mg?.denied_at).toBeTruthy();
    expect(res.messagingGroupId).toBe(mg?.id);
  });

  it('normalizes a raw channel id to <channelType>:<id> (deshi#528)', () => {
    seedOwner('slack:UOWNER');

    routeApprovalsToChannel({ platformId: 'C0SHARED' });

    // 生 ID では引けず、prefix 付きで引ける。
    expect(getMessagingGroupByPlatform('slack', 'C0SHARED')).toBeUndefined();
    expect(getMessagingGroupByPlatform('slack', 'slack:C0SHARED')?.platform_id).toBe('slack:C0SHARED');
  });

  it('accepts an already-prefixed channel id without double-encoding', () => {
    seedOwner('slack:UOWNER');

    const res = routeApprovalsToChannel({ platformId: 'slack:C0SHARED' });

    const mg = getMessagingGroupByPlatform('slack', 'slack:C0SHARED');
    expect(mg?.platform_id).toBe('slack:C0SHARED');
    expect(res.messagingGroupId).toBe(mg?.id);
  });

  it('converges raw-then-prefixed input to one mg with no duplicate user_dms', () => {
    seedOwner('slack:UOWNER');

    const first = routeApprovalsToChannel({ platformId: 'C0SHARED' });
    const second = routeApprovalsToChannel({ platformId: 'slack:C0SHARED' });

    expect(second.created).toBe(false);
    expect(second.messagingGroupId).toBe(first.messagingGroupId);
    // mg は 1 本、user_dms も 1 行に収束する。
    expect(getMessagingGroupByPlatform('slack', 'slack:C0SHARED')).toBeDefined();
    expect(getUserDm('slack:UOWNER', 'slack')?.messaging_group_id).toBe(first.messagingGroupId);
  });

  it('reports a leftover prefix-less messaging_group as legacy (deshi#528 migration)', () => {
    seedOwner('slack:UOWNER');
    // 修正前の壊れた mg（生 ID）が既存の状態。
    createMessagingGroup({
      id: 'mg-broken',
      channel_type: 'slack',
      platform_id: 'C0SHARED',
      name: '壊れ',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });

    const res = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    // 正規 mg（slack:）を新規作成し、壊れた mg を legacy として報告。自動削除はしない。
    expect(res.created).toBe(true);
    expect(res.messagingGroupId).not.toBe('mg-broken');
    expect(res.legacyMessagingGroupId).toBe('mg-broken');
    expect(getMessagingGroup('mg-broken')).toBeDefined();
    // user_dms は正規 mg に向く。
    expect(getUserDm('slack:UOWNER', 'slack')?.messaging_group_id).toBe(res.messagingGroupId);
  });

  it('dedupes a user who is both owner and global admin (redirected once)', () => {
    seedUser('slack:UDUAL', 'slack');
    grantRole({ user_id: 'slack:UDUAL', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'slack:UDUAL', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    const res = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    expect(res.redirected).toEqual(['slack:UDUAL']);
  });

  it('does not mutate a pre-existing external messaging_group when reusing it', () => {
    seedOwner('slack:UOWNER');
    // router が作った正規形（slack:）の通常グループが既存の場合。
    createMessagingGroup({
      id: 'mg-existing',
      channel_type: 'slack',
      platform_id: 'slack:C0SHARED',
      name: '業務チャンネル',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const res = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    expect(res.created).toBe(false);
    expect(res.messagingGroupId).toBe('mg-existing');
    const mg = getMessagingGroupByPlatform('slack', 'slack:C0SHARED');
    // 既存 mg の属性は一切変更しない（denied_at を立てない・is_group/policy 保持）。
    expect(mg?.is_group).toBe(0);
    expect(mg?.unknown_sender_policy).toBe('public');
    expect(mg?.denied_at).toBeFalsy();
  });

  it('redirects owner and global-admin slack user_dms to the shared channel', () => {
    seedOwner('slack:UOWNER');
    seedGlobalAdmin('slack:UADMIN');

    const res = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    expect(res.redirected.sort()).toEqual(['slack:UADMIN', 'slack:UOWNER']);
    expect(getUserDm('slack:UOWNER', 'slack')?.messaging_group_id).toBe(res.messagingGroupId);
    expect(getUserDm('slack:UADMIN', 'slack')?.messaging_group_id).toBe(res.messagingGroupId);
  });

  it('skips owner/admin whose identity is not the target channel_type', () => {
    seedOwner('slack:UOWNER');
    seedGlobalAdmin('telegram:12345', 'telegram');

    const res = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    expect(res.redirected).toEqual(['slack:UOWNER']);
    expect(res.skipped).toEqual(['telegram:12345']);
    expect(getUserDm('telegram:12345', 'slack')).toBeUndefined();
  });

  it('is idempotent — re-running reuses the same mg and re-upserts the same rows', () => {
    seedOwner('slack:UOWNER');

    const first = routeApprovalsToChannel({ platformId: 'C0SHARED' });
    const second = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    expect(second.created).toBe(false);
    expect(second.messagingGroupId).toBe(first.messagingGroupId);
    expect(getUserDm('slack:UOWNER', 'slack')?.messaging_group_id).toBe(first.messagingGroupId);
  });

  it('reuses a pre-existing messaging_group for the channel instead of creating a new one', () => {
    seedOwner('slack:UOWNER');
    // Pre-create the mg (e.g. the channel already exists as a normal group).
    const pre = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    seedGlobalAdmin('slack:ULATE');
    const res = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    expect(res.created).toBe(false);
    expect(res.messagingGroupId).toBe(pre.messagingGroupId);
    expect(getUserDm('slack:ULATE', 'slack')?.messaging_group_id).toBe(pre.messagingGroupId);
  });

  it('includes scoped admins when scopedAgentGroupIds is passed', () => {
    seedOwner('slack:UOWNER');
    createAgentGroup({ id: 'ag-1', name: 'AG-1', folder: 'ag-1', agent_provider: null, created_at: now() });
    seedUser('slack:USCOPED', 'slack');
    grantRole({ user_id: 'slack:USCOPED', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });

    const res = routeApprovalsToChannel({ platformId: 'C0SHARED', scopedAgentGroupIds: ['ag-1'] });

    expect(res.redirected.sort()).toEqual(['slack:UOWNER', 'slack:USCOPED']);
  });
});
