import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectProviderSpawnSurfaces } from './realize.js';
import type { ProviderHostContract } from './registry.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('projectProviderSpawnSurfaces', () => {
  it('derives provider mount paths without creating or reconciling any surface', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-projection-'));
    roots.push(root);
    const groupDir = path.join(root, 'group-that-does-not-exist');
    const sessionDir = path.join(root, 'session-that-does-not-exist');
    const legacyOverlay = vi.fn(async () => ({
      env: { SAFE_SETTING: '1' },
      mounts: [{ hostPath: '/must/not/pass', containerPath: '/legacy', readonly: false }],
    }));
    const contract = {
      seamVersion: 1,
      projectDocument: {
        fileName: 'AGENTS.md',
        containerPath: '/workspace/agent/AGENTS.md',
        mountClass: 'group-state',
      },
      stateVolumes: [],
      skillBackings: [
        {
          id: 'skills',
          location: { kind: 'group-directory', directory: '.provider', subdirectory: 'shared' },
          skillsSubdirectory: 'skills',
          conflictDiagnostics: 'silent',
          templateCopies: 'in-place',
        },
      ],
      skillViews: [],
      files: [],
    } satisfies ProviderHostContract;

    const projection = await projectProviderSpawnSurfaces(contract, 'ag-1', groupDir, sessionDir, legacyOverlay);

    expect(projection.skillBackingPaths.get('skills')).toBe(path.join(groupDir, '.provider', 'shared'));
    expect(projection.contribution).toEqual({ env: { SAFE_SETTING: '1' } });
    expect(fs.existsSync(groupDir)).toBe(false);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });
});
