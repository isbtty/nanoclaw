import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import {
  disablePermissionSplit,
  enablePermissionSplit,
  isPermissionSplitGroup,
  listPermissionSplitGroups,
} from './permission-split.js';

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

    expect(listPermissionSplitGroups()).toEqual(['ag-lab']);
  });

  it('登録を外すと、従来どおりの扱いに戻ること', () => {
    enablePermissionSplit('ag-lab');

    expect(disablePermissionSplit('ag-lab')).toEqual(true);
    expect(isPermissionSplitGroup('ag-lab')).toEqual(false);
  });

  it('登録されていないものを外そうとしたときは、何も起きなかったと分かること', () => {
    expect(disablePermissionSplit('ag-lab')).toEqual(false);
  });

  it('ワークスペースごと削除されても、登録が取り残されないこと', async () => {
    enablePermissionSplit('ag-lab');
    const { getDb } = await import('../db/connection.js');

    expect(() => getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-lab')).not.toThrow();
    expect(listPermissionSplitGroups()).toEqual([]);
  });
});
