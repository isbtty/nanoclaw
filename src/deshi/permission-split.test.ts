import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { enablePermissionSplit, isPermissionSplitGroup, skipsDmScopeLink } from './permission-split.js';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-lab', name: 'Lab', folder: 'lab', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-other', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
});

afterEach(() => {
  closeDb();
});

describe('権限分離モードの適用範囲', () => {
  it('登録していないワークスペースは、従来どおりの扱いになること', () => {
    expect(isPermissionSplitGroup('ag-lab')).toEqual(false);
  });

  it('登録したワークスペースだけが権限分離モードになること', () => {
    enablePermissionSplit('ag-lab');

    expect(isPermissionSplitGroup('ag-lab')).toEqual(true);
    expect(isPermissionSplitGroup('ag-other')).toEqual(false);
  });

  it('同じワークスペースを二重に登録しても壊れないこと', () => {
    enablePermissionSplit('ag-lab');
    enablePermissionSplit('ag-lab');

    expect(isPermissionSplitGroup('ag-lab')).toEqual(true);
  });

  it('ワークスペースごと削除されても、登録が取り残されないこと', async () => {
    enablePermissionSplit('ag-lab');
    const { getDb } = await import('../db/connection.js');

    expect(() => getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-lab')).not.toThrow();
    expect(getDb().prepare('SELECT 1 FROM permission_split_groups').get()).toBeUndefined();
  });
});

describe('DM への知識スコープリンクを飛ばすかの判定', () => {
  it('権限分離を入れた組織の DM では、飛ばすこと', () => {
    enablePermissionSplit('ag-lab');

    expect(skipsDmScopeLink('ag-lab', false)).toEqual(true);
  });

  it('権限分離を入れた組織でも、共有チャンネルなら飛ばさないこと', () => {
    enablePermissionSplit('ag-lab');

    expect(skipsDmScopeLink('ag-lab', true)).toEqual(false);
  });

  it('権限分離を入れていない組織では、DM でも飛ばさないこと', () => {
    expect(skipsDmScopeLink('ag-other', false)).toEqual(false);
  });

  it('権限分離を入れていない組織の共有チャンネルでも、飛ばさないこと', () => {
    expect(skipsDmScopeLink('ag-other', true)).toEqual(false);
  });
});
