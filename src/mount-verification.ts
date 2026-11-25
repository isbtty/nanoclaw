/**
 * Host-only, bounded verification of one configured additional mount.
 *
 * This deliberately composes through the production provider, gateway and
 * session-driver seams.  It never creates a central sessions row and it uses
 * a read-only projection of already-realized provider surfaces, so running a
 * diagnostic cannot rewrite a group's project document or shared skills.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { configFromDb, type ContainerConfig } from './container-config.js';
import { INSTALL_SLUG } from './config.js';
import { buildMounts, composeSessionSpec, resolveProviderName, selectedSkillNames } from './container-runner.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';
import { getSessionDriver } from './drivers/index.js';
import type { SessionHandle, SessionKey, SessionSpec } from './drivers/types.js';
import {
  gatewayRuntimeIdentity,
  getGatewayProvider,
  type GatewayContribution,
  type GatewaySessionProjection,
} from './gateway-providers/index.js';
import { getAgentMailbox } from './mailbox/index.js';
import { validateMount } from './modules/mount-security/index.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';
import { getProviderHostContract } from './provider-contracts/registry.js';
import { projectProviderSpawnSurfaces } from './provider-contracts/realize.js';
import {
  destroySessionMailbox,
  initSessionFolder,
  sessionContextPath,
  sessionDir,
  writeSessionContext,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

export const MOUNT_VERIFICATION_SCHEMA = 'nanoclaw.mount-verification/v1';
export const MOUNT_VERIFICATION_CONTRACT_VERSION = 1;
export const MOUNT_VERIFICATION_CHECKS = ['capability', 'read-marker', 'append-marker', 'deny-path'] as const;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MOUNT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const MARKER_RE = /^[A-Za-z0-9_=:.-]{1,200}$/;
const MAX_PROTECTED_PATHS = 32;
const EXEC_TIMEOUT_MS = 15_000;
const PROJECTION_TIMEOUT_MS = 15_000;
const REQUEST_MUTATION_DEADLINE_MS = 60_000;
const MAX_EXEC_OUTPUT_BYTES = 4096;

export type MountVerificationCheck = (typeof MOUNT_VERIFICATION_CHECKS)[number];

export interface MountVerificationInput {
  id: string;
  mount: string;
  check: MountVerificationCheck;
  run_id?: string;
  relative?: string;
  expect_marker?: string;
  append_marker?: string;
  protected_host_paths?: string[];
  container_path?: string;
}

export interface MountVerificationResult {
  schema: typeof MOUNT_VERIFICATION_SCHEMA;
  contractVersion: typeof MOUNT_VERIFICATION_CONTRACT_VERSION;
  ok: true;
  check: MountVerificationCheck;
  code: 'capability_available' | 'marker_present' | 'marker_appended' | 'marker_already_present' | 'path_denied';
  supportedChecks?: readonly MountVerificationCheck[];
  mountState?: 'absent' | 'ready';
}

export interface MountVerificationFailureDetails {
  schema: typeof MOUNT_VERIFICATION_SCHEMA;
  contractVersion: typeof MOUNT_VERIFICATION_CONTRACT_VERSION;
  ok: false;
  check: MountVerificationCheck;
  code: string;
}

/** Expected public-command failure. Messages and details never contain paths or file contents. */
export class MountVerificationFailure extends Error {
  constructor(
    readonly exitCode: 1 | 2,
    readonly details: MountVerificationFailureDetails,
    message: string,
  ) {
    super(message);
    this.name = 'MountVerificationFailure';
  }
}

interface PreparedRequest {
  input: MountVerificationInput;
  runId?: string;
  protectedHostPaths?: string[];
  deadlineAt: number;
}

type ValidatedRequest = Omit<PreparedRequest, 'deadlineAt'>;

interface MountReadiness {
  config: ContainerConfig;
  group: AgentGroup;
  mountState: 'absent' | 'ready';
  gatewayProjection?: GatewaySessionProjection;
}

interface ProgramResult {
  ok: boolean;
  unavailable: boolean;
}

const runLocks = new Map<string, Promise<void>>();

export async function verifyGroupMount(raw: MountVerificationInput): Promise<MountVerificationResult> {
  const request = { ...validateRequest(raw), deadlineAt: performance.now() + REQUEST_MUTATION_DEADLINE_MS };
  const key = `${request.input.id}\0${request.input.mount}\0${request.runId ?? 'capability'}`;
  return withRunLock(key, () => verifyLocked(request));
}

async function verifyLocked(request: PreparedRequest): Promise<MountVerificationResult> {
  const { input } = request;
  assertRequestActive(request);
  let readiness: MountReadiness;
  try {
    readiness = await inspectMountReadiness(input.id, input.mount, input.check);
  } catch (err) {
    if (err instanceof MountVerificationFailure) throw err;
    throw failure(input.check, 2, 'capability_unavailable', 'Mount verification capability is unavailable.');
  }

  const driver = getSessionDriver();
  try {
    await driver.ensureReady?.();
  } catch {
    throw failure(input.check, 2, 'runtime_unavailable', 'The configured session runtime is unavailable.');
  }

  readiness.gatewayProjection = await projectGatewayBoundary(readiness.group, readiness.config, input.check);
  assertGatewayProjection(readiness.gatewayProjection, request.protectedHostPaths ?? [], input.check);
  assertRequestActive(request);

  if (input.check === 'capability') {
    return success('capability', 'capability_available', {
      supportedChecks: MOUNT_VERIFICATION_CHECKS,
      mountState: readiness.mountState,
    });
  }
  if (readiness.mountState !== 'ready') {
    throw failure(input.check, 1, 'mount_not_ready', 'The selected mount is not configured and ready.');
  }

  return runInProductionBoundary(readiness, request);
}

async function inspectMountReadiness(
  id: string,
  mountName: string,
  check: MountVerificationCheck,
): Promise<MountReadiness> {
  const group = await getAgentGroup(id);
  if (!group) throw failure(check, 1, 'group_not_found', 'The target group does not exist.');
  const row = await getContainerConfig(id);
  if (!row) throw failure(check, 1, 'container_config_missing', 'The target group has no container config.');
  const config = configFromDb(row, group);
  const provider = resolveProviderName(group.agent_provider, config.provider);
  if (!getProviderHostContract(provider)) {
    throw failure(
      check,
      2,
      'provider_projection_unavailable',
      'The selected provider cannot be projected read-only.',
    );
  }

  const configured = config.additionalMounts ?? [];
  if (configured.length === 0) return { config, group, mountState: 'absent' };
  if (configured.length !== 1 || configured[0]?.containerPath !== mountName) {
    throw failure(
      check,
      1,
      'mount_configuration_unsafe',
      'The group must configure exactly the selected additional mount.',
    );
  }
  const checked = validateMount(configured[0]);
  if (
    !checked.allowed ||
    checked.resolvedContainerPath !== mountName ||
    checked.effectiveReadonly !== false ||
    !checked.realHostPath
  ) {
    throw failure(
      check,
      1,
      'mount_configuration_unsafe',
      'The selected mount is invalid or is not effectively read-write.',
    );
  }
  return { config, group, mountState: 'ready' };
}

async function runInProductionBoundary(
  readiness: MountReadiness,
  request: PreparedRequest,
): Promise<MountVerificationResult> {
  const { config, group } = readiness;
  const { input } = request;
  const sessionId = `verify-${randomUUID()}`;
  const key: SessionKey = { installSlug: INSTALL_SLUG, agentGroupId: group.id, sessionId };
  const session: Session = {
    id: sessionId,
    agent_group_id: group.id,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  const contextDirectory = path.dirname(sessionContextPath(group.id, sessionId));
  const contextDirectoryExisted = fs.existsSync(contextDirectory);
  const mailbox = getAgentMailbox();
  const driver = getSessionDriver();
  let handle: SessionHandle | undefined;
  try {
    assertRequestActive(request);
    initSessionFolder(group.id, sessionId);
    const mailboxKey = { agentGroupId: group.id, sessionId };
    writeSessionContext(group.id, sessionId, await mailbox.runnerContext(mailboxKey));

    const provider = resolveProviderName(session.agent_provider, config.provider);
    const contract = getProviderHostContract(provider);
    if (!contract) {
      throw failure(
        input.check,
        2,
        'provider_projection_unavailable',
        'The selected provider cannot be projected read-only.',
      );
    }
    const providerFn = getProviderContainerConfig(provider);
    if (contract.legacyHostAdapter === 'required' && !providerFn) {
      throw failure(input.check, 2, 'provider_projection_unavailable', 'The selected provider adapter is unavailable.');
    }
    const groupDir = path.resolve(process.cwd(), 'groups', group.folder);
    const sessionDirectory = sessionDir(group.id, sessionId);
    const surfaces = await projectProviderSpawnSurfaces(contract, group.id, groupDir, sessionDirectory, async () =>
      Promise.resolve(
        providerFn?.({
          sessionDir: sessionDirectory,
          agentGroupId: group.id,
          groupDir,
          selectedSkills: selectedSkillNames(config),
          hostEnv: process.env,
          coreOwnsProviderSurfaces: true,
        }) ?? {},
      ),
    );
    const mounts = await buildMounts(group, session, config, provider, surfaces.contribution, surfaces);
    assertMountSourcesExist(mounts);

    const containerName = `mount-verify-${Date.now()}`;
    if (!readiness.gatewayProjection) {
      throw failure(input.check, 2, 'gateway_projection_unavailable', 'The gateway mount boundary was not projected.');
    }

    // The projection above proves every real gateway mount source and
    // destination is disjoint from both the selected /workspace/extra mount
    // and every protected path supplied by a deny check.  Omit those unrelated
    // CA/stub mounts and all gateway env from the diagnostic runtime: this
    // preserves the filesystem visibility under test without handing a
    // production credential surface to a probe container.
    const diagnosticGateway: GatewayContribution = {
      networkAccess: { endpoint: 'mount-verification.invalid', target: { kind: 'host' } },
    };

    const spec = composeSessionSpec({
      agentGroup: group,
      session,
      containerName,
      mounts,
      containerConfig: config,
      contribution: surfaces.contribution,
      gateway: diagnosticGateway,
      mailboxEnvironment: await mailbox.runnerEnvironment(mailboxKey),
    });
    replaceAgentCommandWithVerifierIdle(spec);

    if (input.check === 'deny-path') {
      assertProtectedPathsNotMounted(spec, request.protectedHostPaths!);
    }

    assertRequestActive(request);
    handle = await driver.prepare(spec);
    assertRequestActive(request);
    await handle.start();
    const status = await handle.status();
    if (status.phase !== 'running') {
      throw failure(input.check, 2, 'runtime_start_failed', 'The verification runtime did not start.');
    }
    assertRequestActive(request);

    const mountPath = `/workspace/extra/${input.mount}`;
    if (input.check === 'read-marker') {
      const result = await executeProgram(
        handle,
        {
          check: 'read-marker',
          mountPath,
          runId: request.runId,
          relative: input.relative,
          expectMarker: input.expect_marker,
        },
        executionBudget(request),
      );
      if (result.unavailable) throw runtimeExecutionFailure(input.check);
      if (!result.ok) throw failure(input.check, 1, 'marker_not_present', 'The expected marker was not observed.');
      return success(input.check, 'marker_present');
    }

    if (input.check === 'append-marker') {
      // Establish idempotency before the write while the per-group/mount/run
      // host lock is held. A retried command sees the exact marker and does
      // not race another read-before-append sequence.
      const before = await executeProgram(
        handle,
        {
          check: 'read-marker',
          mountPath,
          runId: request.runId,
          relative: input.relative,
          expectMarker: input.append_marker,
        },
        executionBudget(request),
      );
      if (before.unavailable) throw runtimeExecutionFailure(input.check);
      assertRequestActive(request);
      const appended = await executeProgram(
        handle,
        {
          check: 'append-marker',
          mountPath,
          runId: request.runId,
          relative: input.relative,
          expectMarker: input.expect_marker,
          appendMarker: input.append_marker,
        },
        executionBudget(request),
      );
      if (appended.unavailable) throw runtimeExecutionFailure(input.check);
      if (!appended.ok) throw failure(input.check, 1, 'marker_append_failed', 'The scoped marker edit failed.');
      return success(input.check, before.ok ? 'marker_already_present' : 'marker_appended');
    }

    const denied = await executeProgram(
      handle,
      {
        check: 'deny-path',
        mountPath,
        runId: request.runId,
        containerPath: input.container_path,
      },
      executionBudget(request),
    );
    if (denied.unavailable) throw runtimeExecutionFailure(input.check);
    if (!denied.ok) throw failure(input.check, 1, 'path_exposed', 'The protected path is visible in the runtime.');
    return success(input.check, 'path_denied');
  } catch (err) {
    throw err instanceof MountVerificationFailure
      ? err
      : failure(input.check, 2, 'runtime_unavailable', 'The verification runtime is unavailable.');
  } finally {
    const cleanupErrors: unknown[] = [];
    if (handle) {
      try {
        await handle.stop('mount-verification-complete');
        await assertRuntimeReaped(driver, key);
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    try {
      await destroySessionMailbox(group.id, sessionId);
      fs.rmSync(sessionDir(group.id, sessionId), { recursive: true, force: true });
      if (!contextDirectoryExisted) {
        try {
          fs.rmdirSync(contextDirectory);
        } catch (err) {
          if (!['ENOENT', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
        }
      }
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (cleanupErrors.length > 0) {
      throw failure(input.check, 2, 'runtime_cleanup_failed', 'The verification runtime could not be fully reaped.');
    }
  }
}

async function projectGatewayBoundary(
  group: AgentGroup,
  config: ContainerConfig,
  check: MountVerificationCheck,
): Promise<GatewaySessionProjection> {
  const projectGateway = getGatewayProvider().sessions.project;
  if (!projectGateway) {
    throw failure(check, 2, 'gateway_projection_unavailable', 'The gateway cannot be projected read-only.');
  }
  const sessionId = `verify-project-${randomUUID()}`;
  const key = { installSlug: INSTALL_SLUG, agentGroupId: group.id, sessionId };
  const provider = resolveProviderName(group.agent_provider, config.provider);
  const signal = AbortSignal.timeout(PROJECTION_TIMEOUT_MS);
  try {
    return await raceAbort(
      projectGateway(
        {
          key,
          runtimeIdentity: gatewayRuntimeIdentity(key),
          groupName: group.name,
          provider,
          containerName: `mount-verify-project-${Date.now()}`,
          capabilities: getSessionDriver().capabilities(),
        },
        signal,
      ),
      signal,
    );
  } catch (err) {
    if (err instanceof MountVerificationFailure) throw err;
    throw failure(
      check,
      2,
      'gateway_projection_unavailable',
      'The gateway mount boundary could not be projected.',
    );
  }
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('operation aborted');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('operation aborted'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', abort);
        reject(err);
      },
    );
  });
}

function replaceAgentCommandWithVerifierIdle(spec: SessionSpec): void {
  const agent = spec.containers.find((container) => container.role === 'agent');
  if (!agent) throw new Error('agent container missing');
  // The filesystem check needs no network and no provider/gateway config.
  // Keep the production mounts/hardening/resources while removing every
  // unrelated authority from the short-lived diagnostic process.
  spec.network = 'none';
  agent.env = {};
  agent.contributedEnv = {};
  agent.command = ['node'];
  agent.args = ['-e', 'setInterval(() => {}, 1000)'];
}

function assertMountSourcesExist(mounts: readonly { hostPath: string }[]): void {
  for (const mount of mounts) {
    try {
      fs.lstatSync(mount.hostPath);
    } catch {
      throw new Error('projected mount source missing');
    }
  }
}

function assertProtectedPathsNotMounted(spec: SessionSpec, protectedPaths: readonly string[]): void {
  const mounts = spec.containers.flatMap((container) => container.mounts);
  for (const mount of mounts) {
    const lexicalHostPath = path.resolve(mount.hostPath);
    let realHostPath: string;
    try {
      realHostPath = fs.realpathSync(lexicalHostPath);
    } catch {
      throw failure('deny-path', 2, 'mount_source_unavailable', 'An assembled mount source cannot be resolved.');
    }
    if (
      protectedPaths.some(
        (protectedPath) => pathsOverlap(lexicalHostPath, protectedPath) || pathsOverlap(realHostPath, protectedPath),
      )
    ) {
      throw failure('deny-path', 1, 'path_exposed', 'A protected host path overlaps the assembled runtime mounts.');
    }
  }
}

function assertGatewayProjection(
  projection: GatewaySessionProjection,
  protectedPaths: readonly string[],
  check: MountVerificationCheck,
): void {
  if (!projection || !Array.isArray(projection.mounts)) {
    throw failure(check, 2, 'gateway_projection_unavailable', 'The gateway returned no mount projection.');
  }
  const extraNamespace = '/workspace/extra';
  for (const mount of projection.mounts) {
    if (
      !mount ||
      typeof mount.hostSourceRoot !== 'string' ||
      typeof mount.containerPath !== 'string' ||
      !path.isAbsolute(mount.hostSourceRoot) ||
      path.normalize(mount.hostSourceRoot) !== mount.hostSourceRoot ||
      !path.isAbsolute(mount.containerPath) ||
      path.posix.normalize(mount.containerPath) !== mount.containerPath
    ) {
      throw failure(check, 2, 'gateway_projection_unavailable', 'The gateway mount projection is invalid.');
    }
    let realSourceRoot: string;
    try {
      realSourceRoot = fs.realpathSync(mount.hostSourceRoot);
    } catch {
      throw failure(
        check,
        2,
        'gateway_projection_unavailable',
        'A projected gateway source root is unavailable.',
      );
    }
    if (realSourceRoot !== mount.hostSourceRoot) {
      throw failure(check, 2, 'gateway_projection_unavailable', 'A gateway source root is not canonical.');
    }
    // No gateway may occupy this namespace in a diagnostic that claims the
    // selected additional mount and deny aliases have production-equivalent
    // visibility. Ancestor and descendant overlap both fail closed.
    if (posixPathsOverlap(mount.containerPath, extraNamespace)) {
      throw failure(check, 1, 'gateway_destination_overlap', 'A gateway mount overlaps the verified namespace.');
    }
    if (protectedPaths.some((protectedPath) => pathsOverlap(realSourceRoot, protectedPath))) {
      throw failure(check, 1, 'path_exposed', 'A protected host path overlaps a gateway mount source.');
    }
  }
}

function posixPathsOverlap(left: string, right: string): boolean {
  const l = path.posix.normalize(left);
  const r = path.posix.normalize(right);
  const lToR = path.posix.relative(l, r);
  const rToL = path.posix.relative(r, l);
  const contained = (relative: string) =>
    relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
  return contained(lToR) || contained(rToL);
}

export function pathsOverlap(left: string, right: string): boolean {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return isContainedRelative(relativeLeft) || isContainedRelative(relativeRight);
}

function isContainedRelative(relative: string): boolean {
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertRequestActive(request: PreparedRequest): void {
  if (performance.now() >= request.deadlineAt) {
    throw failure(request.input.check, 2, 'request_expired', 'The verification request expired before the next action.');
  }
}

function executionBudget(request: PreparedRequest): number {
  assertRequestActive(request);
  return Math.max(1, Math.min(EXEC_TIMEOUT_MS, Math.floor(request.deadlineAt - performance.now())));
}

async function executeProgram(
  handle: SessionHandle,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<ProgramResult> {
  // Lazy import keeps a packaging error in this optional diagnostic from
  // preventing the NanoClaw host or unrelated ncl commands from starting.
  let program: string;
  try {
    ({ MOUNT_VERIFICATION_PROGRAM: program } = await import('./mount-verification-program.js'));
  } catch {
    return { ok: false, unavailable: true };
  }
  const exec = handle.execSpec(['node', '-e', program, JSON.stringify(request)]);
  return runBounded(exec.bin, exec.argsPlain, timeoutMs);
}

async function runBounded(bin: string, args: readonly string[], timeoutMs: number): Promise<ProgramResult> {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const child = spawn(bin, [...args], {
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (result: ProgramResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const terminate = () => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        if (settled) return;
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
      }, 250).unref();
    };
    const timer = setTimeout(terminate, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_EXEC_OUTPUT_BYTES) return terminate();
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_EXEC_OUTPUT_BYTES) terminate();
    });
    child.once('error', () => finish({ ok: false, unavailable: true }));
    child.once('close', (code) => {
      const output = stdout.toString('utf8');
      const trueFrame = output === '{"ok":true}\n';
      const falseFrame = output === '{"ok":false}\n';
      const validResult = (code === 0 && trueFrame) || (code === 1 && falseFrame);
      finish({
        ok: !timedOut && stderrBytes === 0 && code === 0 && trueFrame,
        unavailable: timedOut || code === null || stderrBytes > 0 || !validResult,
      });
    });
  });
}

async function assertRuntimeReaped(driver: ReturnType<typeof getSessionDriver>, key: SessionKey): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const survivor = (await driver.listSessions(INSTALL_SLUG)).find(
      (entry) =>
        entry.handle.key.installSlug === key.installSlug &&
        entry.handle.key.agentGroupId === key.agentGroupId &&
        entry.handle.key.sessionId === key.sessionId,
    );
    if (!survivor) return;
    await survivor.handle.stop('mount-verification-reap');
  }
  const survived = (await driver.listSessions(INSTALL_SLUG)).some(
    (entry) =>
      entry.handle.key.installSlug === key.installSlug &&
      entry.handle.key.agentGroupId === key.agentGroupId &&
      entry.handle.key.sessionId === key.sessionId,
  );
  if (survived) throw new Error('verification runtime survived cleanup');
}

function validateRequest(raw: MountVerificationInput): ValidatedRequest {
  if (!raw || typeof raw !== 'object')
    throw failure('capability', 2, 'invalid_request', 'Invalid verification request.');
  const safeCheck = MOUNT_VERIFICATION_CHECKS.includes(raw.check) ? raw.check : 'capability';
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 200) {
    throw failure(safeCheck, 2, 'invalid_request', 'Invalid group id.');
  }
  if (typeof raw.mount !== 'string' || !MOUNT_NAME_RE.test(raw.mount)) {
    throw failure(safeCheck, 2, 'invalid_request', 'Invalid mount name.');
  }
  if (!MOUNT_VERIFICATION_CHECKS.includes(raw.check)) {
    throw failure('capability', 2, 'invalid_request', 'Invalid verification check.');
  }
  if (raw.check === 'capability') {
    rejectPresent(raw, [
      'run_id',
      'relative',
      'expect_marker',
      'append_marker',
      'protected_host_paths',
      'container_path',
    ]);
    return { input: raw };
  }
  if (typeof raw.run_id !== 'string' || !RUN_ID_RE.test(raw.run_id)) {
    throw failure(raw.check, 2, 'invalid_request', 'Invalid run id.');
  }
  if (raw.check === 'deny-path') {
    rejectPresent(raw, ['relative', 'expect_marker', 'append_marker']);
    if (
      !Array.isArray(raw.protected_host_paths) ||
      raw.protected_host_paths.length < 1 ||
      raw.protected_host_paths.length > MAX_PROTECTED_PATHS
    ) {
      throw failure(raw.check, 2, 'invalid_request', 'Invalid protected path set.');
    }
    const protectedHostPaths = raw.protected_host_paths.map(validateProtectedPath);
    if (
      typeof raw.container_path !== 'string' ||
      !raw.container_path.startsWith('/workspace/extra/') ||
      !MOUNT_NAME_RE.test(raw.container_path.slice('/workspace/extra/'.length)) ||
      raw.container_path === `/workspace/extra/${raw.mount}`
    ) {
      throw failure(raw.check, 2, 'invalid_request', 'Invalid protected container path.');
    }
    return { input: raw, runId: raw.run_id, protectedHostPaths };
  }

  rejectPresent(raw, ['protected_host_paths', 'container_path']);
  if (typeof raw.relative !== 'string' || raw.relative.length === 0 || raw.relative.length > 220) {
    throw failure(raw.check, 2, 'invalid_request', 'Invalid fixture path.');
  }
  if (!validMarker(raw.expect_marker, raw.run_id)) {
    throw failure(raw.check, 2, 'invalid_request', 'Invalid expected marker.');
  }
  if (raw.check === 'read-marker') {
    rejectPresent(raw, ['append_marker']);
  } else if (!validMarker(raw.append_marker, raw.run_id) || raw.append_marker === raw.expect_marker) {
    throw failure(raw.check, 2, 'invalid_request', 'Invalid append marker.');
  }
  return { input: raw, runId: raw.run_id };
}

function validMarker(value: unknown, runId: string): value is string {
  return typeof value === 'string' && MARKER_RE.test(value) && value.endsWith(runId);
}

function rejectPresent(input: MountVerificationInput, fields: Array<keyof MountVerificationInput>): void {
  if (fields.some((field) => input[field] !== undefined)) {
    throw failure(input.check, 2, 'invalid_request', 'The request contains fields that do not apply to this check.');
  }
}

function validateProtectedPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes('\0') ||
    /[\r\n]/.test(value)
  ) {
    throw failure('deny-path', 2, 'invalid_request', 'Invalid protected host path.');
  }
  if (!path.isAbsolute(value) || path.normalize(value) !== value || (value.length > 1 && value.endsWith(path.sep))) {
    throw failure('deny-path', 2, 'invalid_request', 'Protected host paths must be lexical canonical absolute paths.');
  }
  return value;
}

function success(
  check: MountVerificationCheck,
  code: MountVerificationResult['code'],
  extra: Pick<MountVerificationResult, 'supportedChecks' | 'mountState'> = {},
): MountVerificationResult {
  return {
    schema: MOUNT_VERIFICATION_SCHEMA,
    contractVersion: MOUNT_VERIFICATION_CONTRACT_VERSION,
    ok: true,
    check,
    code,
    ...extra,
  };
}

function failure(
  check: MountVerificationCheck,
  exitCode: 1 | 2,
  code: string,
  message: string,
): MountVerificationFailure {
  return new MountVerificationFailure(
    exitCode,
    {
      schema: MOUNT_VERIFICATION_SCHEMA,
      contractVersion: MOUNT_VERIFICATION_CONTRACT_VERSION,
      ok: false,
      check,
      code,
    },
    message,
  );
}

function runtimeExecutionFailure(check: MountVerificationCheck): MountVerificationFailure {
  return failure(check, 2, 'runtime_execution_unavailable', 'The runtime verification program did not complete.');
}

async function withRunLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = runLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  runLocks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (runLocks.get(key) === tail) runLocks.delete(key);
  }
}
