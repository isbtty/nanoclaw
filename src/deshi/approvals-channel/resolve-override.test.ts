/**
 * boswell#712 — 配信時ライブ判定 override のテスト。
 *
 * 本丸は「配線後に付与した admin にも効くこと」。旧スナップショット方式が
 * 落としていたケースなので回帰テストとして必須。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup, deleteMessagingGroup } from '../../db/messaging-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { grantRole, revokeRole } from '../../modules/permissions/db/user-roles.js';
import { setApprovalsChannel } from './db.js';
import { resolveApprovalsChannelOverride } from './resolve-override.js';

function now(): string {
  return new Date().toISOString();
}

function seedUser(id: string, kind = 'slack'): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

function seedSharedChannel(id = 'mg-shared'): string {
  createMessagingGroup({
    id,
    channel_type: 'slack',
    platform_id: 'slack:C0SHARED',
    name: '承認',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  setApprovalsChannel('slack', id);
  return id;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('resolveApprovalsChannelOverride', () => {
  it('returns null when nothing is wired (default install is a no-op)', () => {
    seedUser('slack:UOWNER');
    grantRole({ user_id: 'slack:UOWNER', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    expect(resolveApprovalsChannelOverride('slack:UOWNER', 'slack')).toBeNull();
  });

  it('returns the shared channel for an owner', () => {
    const mgId = seedSharedChannel();
    seedUser('slack:UOWNER');
    grantRole({ user_id: 'slack:UOWNER', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    expect(resolveApprovalsChannelOverride('slack:UOWNER', 'slack')?.id).toBe(mgId);
  });

  it('returns the shared channel for a global admin', () => {
    const mgId = seedSharedChannel();
    seedUser('slack:UADMIN');
    grantRole({ user_id: 'slack:UADMIN', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    expect(resolveApprovalsChannelOverride('slack:UADMIN', 'slack')?.id).toBe(mgId);
  });

  it('returns the shared channel for a scoped admin', () => {
    const mgId = seedSharedChannel();
    createAgentGroup({ id: 'ag-1', name: 'AG-1', folder: 'ag-1', agent_provider: null, created_at: now() });
    seedUser('slack:USCOPED');
    grantRole({ user_id: 'slack:USCOPED', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });

    expect(resolveApprovalsChannelOverride('slack:USCOPED', 'slack')?.id).toBe(mgId);
  });

  it('returns null for a user with no role (falls back to normal DM resolution)', () => {
    seedSharedChannel();
    seedUser('slack:UPLAIN');

    expect(resolveApprovalsChannelOverride('slack:UPLAIN', 'slack')).toBeNull();
  });

  it('applies to an admin granted AFTER wiring (boswell#712 regression)', () => {
    const mgId = seedSharedChannel();
    seedUser('slack:ULATE');
    // 配線はすでに済んでいる。ここで初めて admin を付与する。
    grantRole({ user_id: 'slack:ULATE', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    expect(resolveApprovalsChannelOverride('slack:ULATE', 'slack')?.id).toBe(mgId);
  });

  it('stops applying once the role is revoked', () => {
    seedSharedChannel();
    seedUser('slack:UADMIN');
    grantRole({ user_id: 'slack:UADMIN', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });

    revokeRole('slack:UADMIN', 'admin', null);

    expect(resolveApprovalsChannelOverride('slack:UADMIN', 'slack')).toBeNull();
  });

  it('returns null when the wired messaging_group was deleted', () => {
    const mgId = seedSharedChannel();
    seedUser('slack:UOWNER');
    grantRole({ user_id: 'slack:UOWNER', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    deleteMessagingGroup(mgId);

    expect(resolveApprovalsChannelOverride('slack:UOWNER', 'slack')).toBeNull();
  });

  it('returns null for an identity on a different channel_type', () => {
    seedSharedChannel();
    seedUser('line:Uowner', 'line');
    grantRole({ user_id: 'line:Uowner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    expect(resolveApprovalsChannelOverride('line:Uowner', 'line')).toBeNull();
  });
});
