/**
 * deshi#517 — routeApprovalsToChannel（案D 配線ヘルパ）のテスト。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
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
    const mg = getMessagingGroupByPlatform('slack', 'C0SHARED');
    expect(mg).toBeDefined();
    expect(mg?.is_group).toBe(1);
    expect(mg?.unknown_sender_policy).toBe('strict');
    // denied_at を立てて router の channel 登録 escalation を確実に殺す（配信は妨げない）。
    expect(mg?.denied_at).toBeTruthy();
    expect(res.messagingGroupId).toBe(mg?.id);
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
    // 他用途の通常グループ（is_group=0, denied_at 無し）が同じ platform_id で既存の場合。
    createMessagingGroup({
      id: 'mg-existing',
      channel_type: 'slack',
      platform_id: 'C0SHARED',
      name: '業務チャンネル',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const res = routeApprovalsToChannel({ platformId: 'C0SHARED' });

    expect(res.created).toBe(false);
    expect(res.messagingGroupId).toBe('mg-existing');
    const mg = getMessagingGroupByPlatform('slack', 'C0SHARED');
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
