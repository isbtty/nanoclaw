import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '/tmp/nanoclaw-mount-verification-test',
  programResults: [] as boolean[],
  preparedSpec: undefined as unknown,
  mountConfigured: true,
  stop: vi.fn(async () => {}),
  project: vi.fn(async () => ({ mounts: [] as Array<{ hostSourceRoot: string; containerPath: string }> })),
}));

vi.mock('./config.js', () => ({ INSTALL_SLUG: 'test-install' }));
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async () => ({
    id: 'ag-1',
    name: 'Verifier',
    folder: 'verifier',
    agent_provider: null,
    created_at: '2026-01-01T00:00:00.000Z',
  })),
}));
vi.mock('./db/container-configs.js', () => ({ getContainerConfig: vi.fn(async () => ({ agent_group_id: 'ag-1' })) }));
vi.mock('./container-config.js', () => ({
  configFromDb: vi.fn(() => ({
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: state.mountConfigured
      ? [{ hostPath: path.join(state.root, 'wiki'), containerPath: 'wiki', readonly: false }]
      : [],
    skills: [],
    provider: 'claude',
  })),
}));
vi.mock('./modules/mount-security/index.js', () => ({
  validateMount: vi.fn(() => ({
    allowed: true,
    realHostPath: path.join(state.root, 'wiki'),
    resolvedContainerPath: 'wiki',
    effectiveReadonly: false,
  })),
}));
vi.mock('./providers/provider-container-registry.js', () => ({ getProviderContainerConfig: vi.fn(() => () => ({})) }));
vi.mock('./provider-contracts/registry.js', () => ({
  getProviderHostContract: vi.fn(() => ({ stateVolumes: [], skillBackings: [], skillViews: [], files: [] })),
}));
vi.mock('./provider-contracts/realize.js', () => ({
  projectProviderSpawnSurfaces: vi.fn(async () => ({ skillBackingPaths: new Map(), contribution: {} })),
}));
vi.mock('./mailbox/index.js', () => ({
  registerAgentMailbox: vi.fn(),
  getAgentMailbox: vi.fn(() => ({
    runnerContext: vi.fn(async () => null),
    runnerEnvironment: vi.fn(async () => ({})),
  })),
}));
vi.mock('./session-manager.js', () => ({
  initSessionFolder: vi.fn(),
  destroySessionMailbox: vi.fn(async () => {}),
  sessionDir: vi.fn((_group: string, session: string) => path.join(state.root, 'sessions', session)),
  sessionContextPath: vi.fn((_group: string, session: string) => path.join(state.root, 'context', `${session}.json`)),
  writeSessionContext: vi.fn(),
}));
vi.mock('./gateway-providers/index.js', () => ({
  gatewayRuntimeIdentity: vi.fn(() => 'runtime-id'),
  getGatewayProvider: vi.fn(() => ({ sessions: { project: state.project } })),
  resetGatewayProvider: vi.fn(),
}));

const handle = vi.hoisted(() => ({
  key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId: 'placeholder' },
  name: 'fake-verifier',
  start: vi.fn(async () => {}),
  status: vi.fn(async () => ({ phase: 'running' as const })),
  stop: state.stop,
  execSpec: vi.fn(() => {
    const ok = state.programResults.shift() ?? false;
    return {
      bin: process.execPath,
      argsTty: [],
      argsPlain: [
        '-e',
        `process.stdout.write(${JSON.stringify(JSON.stringify({ ok }) + '\n')});process.exit(${ok ? 0 : 1})`,
      ],
    };
  }),
}));

const driver = vi.hoisted(() => ({
  kind: 'fake',
  capabilities: vi.fn(() => ({
    isolationTiers: ['container'],
    admissionEnforced: true,
    networkPolicy: 'declarative',
    encryptedVolumes: false,
    unrealized: [],
    sharedNetworkNamespace: false,
    auxiliaryContainers: false,
    imageBuild: false,
  })),
  ensureReady: vi.fn(async () => {}),
  prepare: vi.fn(async (spec) => {
    state.preparedSpec = spec;
    return handle;
  }),
  listSessions: vi.fn(async () => []),
}));

vi.mock('./drivers/index.js', () => ({ getSessionDriver: vi.fn(() => driver) }));
vi.mock('./container-runner.js', () => ({
  resolveProviderName: vi.fn(() => 'claude'),
  selectedSkillNames: vi.fn(() => []),
  buildMounts: vi.fn(async () => [
    {
      hostPath: path.join(state.root, 'wiki'),
      containerPath: '/workspace/extra/wiki',
      readonly: false,
      mountClass: 'allowlisted-extra',
      scope: 'ag-1',
    },
  ]),
  composeSessionSpec: vi.fn(({ agentGroup, session, mounts }) => ({
    key: { installSlug: 'test-install', agentGroupId: agentGroup.id, sessionId: session.id },
    labels: {},
    containers: [
      {
        role: 'agent',
        image: 'fixture',
        env: { SHOULD_BE_REMOVED: 'yes' },
        contributedEnv: { ALSO_REMOVED: 'yes' },
        mounts: mounts.map((mount: { hostPath: string; containerPath: string; readonly: boolean }) => ({
          class: 'allowlisted-extra',
          hostPath: mount.hostPath,
          containerPath: mount.containerPath,
          mode: mount.readonly ? 'ro' : 'rw',
          groupScope: 'ag-1',
        })),
      },
    ],
    network: 'shared-private',
    networkAccess: { endpoint: 'gateway', target: { kind: 'host' } },
    hardening: 'standard',
    resources: {},
    runtimeTier: 'container',
    stopGraceSeconds: 1,
  })),
}));

import { MountVerificationFailure, pathsOverlap, verifyGroupMount } from './mount-verification.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.programResults = [];
  state.preparedSpec = undefined;
  state.mountConfigured = true;
  fs.rmSync(state.root, { recursive: true, force: true });
  fs.mkdirSync(path.join(state.root, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(state.root, 'gateway'), { recursive: true });
  state.project.mockResolvedValue({
    mounts: [
      { hostSourceRoot: fs.realpathSync(path.join(state.root, 'gateway')), containerPath: '/tmp/gateway-ca.pem' },
    ],
  });
});

afterEach(() => fs.rmSync(state.root, { recursive: true, force: true }));

describe('verifyGroupMount', () => {
  it('reports capability without starting a runtime and projects the gateway read-only', async () => {
    await expect(verifyGroupMount({ id: 'ag-1', mount: 'wiki', check: 'capability' })).resolves.toMatchObject({
      ok: true,
      check: 'capability',
      code: 'capability_available',
      mountState: 'ready',
    });
    expect(state.project).toHaveBeenCalledOnce();
    expect(driver.prepare).not.toHaveBeenCalled();
  });

  it('reports capability before the selected mount has been configured', async () => {
    state.mountConfigured = false;
    await expect(verifyGroupMount({ id: 'ag-1', mount: 'wiki', check: 'capability' })).resolves.toMatchObject({
      ok: true,
      check: 'capability',
      code: 'capability_available',
      mountState: 'absent',
    });
    expect(state.project).toHaveBeenCalledOnce();
    expect(driver.prepare).not.toHaveBeenCalled();
  });

  it('runs a marker read with the production mount but no network or credential env', async () => {
    state.programResults = [true];
    await expect(
      verifyGroupMount({
        id: 'ag-1',
        mount: 'wiki',
        check: 'read-marker',
        run_id: 'run.1',
        relative: 'references/v2-through-test-run.1.md',
        expect_marker: 'FIXTURE=run.1',
      }),
    ).resolves.toMatchObject({ code: 'marker_present' });

    const spec = state.preparedSpec as {
      network: string;
      containers: Array<{ env: Record<string, string>; contributedEnv: Record<string, string>; mounts: unknown[] }>;
    };
    expect(spec.network).toBe('none');
    expect(spec.containers[0].env).toEqual({});
    expect(spec.containers[0].contributedEnv).toEqual({});
    expect(spec.containers[0].mounts).toHaveLength(1);
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it('detects an idempotent append without appending a second copy', async () => {
    state.programResults = [true, true];
    await expect(
      verifyGroupMount({
        id: 'ag-1',
        mount: 'wiki',
        check: 'append-marker',
        run_id: 'run-2',
        relative: 'references/v2-through-test-run-2.md',
        expect_marker: 'INITIAL=run-2',
        append_marker: 'EDIT=run-2',
      }),
    ).resolves.toMatchObject({ code: 'marker_already_present' });
    expect(handle.execSpec).toHaveBeenCalledTimes(2);
  });

  it('appends once when the edit marker is not present yet', async () => {
    state.programResults = [false, true];
    await expect(
      verifyGroupMount({
        id: 'ag-1',
        mount: 'wiki',
        check: 'append-marker',
        run_id: 'run-append',
        relative: 'references/v2-through-test-run-append.md',
        expect_marker: 'INITIAL=run-append',
        append_marker: 'EDIT=run-append',
      }),
    ).resolves.toMatchObject({ code: 'marker_appended' });
  });

  it('serializes concurrent append checks for the same group, mount, and run', async () => {
    state.programResults = [false, true, true, true];
    const request = {
      id: 'ag-1',
      mount: 'wiki',
      check: 'append-marker' as const,
      run_id: 'run-locked',
      relative: 'references/v2-through-test-run-locked.md',
      expect_marker: 'INITIAL=run-locked',
      append_marker: 'EDIT=run-locked',
    };
    const results = await Promise.all([verifyGroupMount(request), verifyGroupMount(request)]);
    expect(results.map((result) => result.code)).toEqual(['marker_appended', 'marker_already_present']);
    expect(handle.execSpec).toHaveBeenCalledTimes(4);
  });

  it('does not start or exec after the host mutation deadline, and still reaps prepare output', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    driver.prepare.mockImplementationOnce(async (spec) => {
      state.preparedSpec = spec;
      now = 60_001;
      return handle;
    });
    try {
      await expect(
        verifyGroupMount({
          id: 'ag-1',
          mount: 'wiki',
          check: 'read-marker',
          run_id: 'run-deadline',
          relative: 'references/v2-through-test-run-deadline.md',
          expect_marker: 'INITIAL=run-deadline',
        }),
      ).rejects.toMatchObject({
        exitCode: 2,
        details: expect.objectContaining({ check: 'read-marker', code: 'request_expired' }),
      });
      expect(handle.start).not.toHaveBeenCalled();
      expect(handle.execSpec).not.toHaveBeenCalled();
      expect(handle.stop).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('fails before launch when a projected gateway source overlaps a protected path', async () => {
    const protectedRoot = path.join(state.root, 'protected');
    fs.mkdirSync(path.join(protectedRoot, 'gateway'), { recursive: true });
    state.project.mockResolvedValue({
      mounts: [
        { hostSourceRoot: fs.realpathSync(path.join(protectedRoot, 'gateway')), containerPath: '/tmp/gateway-ca.pem' },
      ],
    });
    await expect(
      verifyGroupMount({
        id: 'ag-1',
        mount: 'wiki',
        check: 'deny-path',
        run_id: 'run-3',
        protected_host_paths: [fs.realpathSync(protectedRoot)],
        container_path: '/workspace/extra/protected',
      }),
    ).rejects.toMatchObject<Partial<MountVerificationFailure>>({
      exitCode: 1,
      details: expect.objectContaining({ check: 'deny-path', code: 'path_exposed' }),
    });
    expect(driver.prepare).not.toHaveBeenCalled();
  });

  it('rejects a gateway destination anywhere in the verified extra namespace', async () => {
    state.project.mockResolvedValue({
      mounts: [
        {
          hostSourceRoot: fs.realpathSync(path.join(state.root, 'gateway')),
          containerPath: '/workspace/extra/other',
        },
      ],
    });
    await expect(verifyGroupMount({ id: 'ag-1', mount: 'wiki', check: 'capability' })).rejects.toMatchObject({
      exitCode: 1,
      details: expect.objectContaining({ code: 'gateway_destination_overlap' }),
    });
  });

  it('rejects malformed run ids before any projection or runtime work', async () => {
    await expect(
      verifyGroupMount({
        id: 'ag-1',
        mount: 'wiki',
        check: 'read-marker',
        run_id: '../bad',
        relative: 'INDEX.md',
        expect_marker: 'X=../bad',
      }),
    ).rejects.toMatchObject({ exitCode: 2, details: expect.objectContaining({ code: 'invalid_request' }) });
    expect(state.project).not.toHaveBeenCalled();
  });
});

describe('pathsOverlap', () => {
  it('detects both ancestor directions but not siblings', () => {
    expect(pathsOverlap('/safe/root', '/safe/root/child')).toBe(true);
    expect(pathsOverlap('/safe/root/child', '/safe/root')).toBe(true);
    expect(pathsOverlap('/safe/root-a', '/safe/root-b')).toBe(false);
  });
});
