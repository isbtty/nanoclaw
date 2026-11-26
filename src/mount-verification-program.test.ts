import { closeSync, constants, linkSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { validRequest, checkFile, networkIsIsolated } = createRequire(import.meta.url)(
  '../container/agent-runner/verify-mounted-fixture.cjs',
);
const runId = '20261126T000000Z-123-456';
const request = {
  check: 'append-marker',
  mountPath: '/workspace/extra/team',
  runId,
  relative: `references/test-${runId}.md`,
  expectMarker: `TEST_INITIAL=${runId}`,
  appendMarker: `TEST_EDIT=${runId}`,
};

const networkReader = (devices: Record<string, { type: string; flags: string; operstate: string }>) => {
  const files = new Map<string, string>();
  files.set(
    '/proc/net/dev',
    'Inter-| Receive | Transmit\n face |bytes |bytes\n' +
      Object.keys(devices)
        .map((name) => ` ${name}: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`)
        .join('\n') +
      '\n',
  );
  for (const [name, device] of Object.entries(devices)) {
    for (const [field, value] of Object.entries(device)) files.set(`/sys/class/net/${name}/${field}`, value + '\n');
  }
  return (file: string) => {
    const value = files.get(file);
    if (value === undefined) throw new Error('unexpected network fixture path');
    return value;
  };
};

const loopback = { type: '772', flags: '0x9', operstate: 'unknown' };

describe('mounted fixture verification', () => {
  let dir: string;
  let file: string;
  let fd: number;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ncl-verify-fixture-'));
    file = path.join(dir, 'fixture.md');
    writeFileSync(file, request.expectMarker + '\n');
    fd = openSync(file, constants.O_RDWR | constants.O_APPEND);
  });
  afterEach(() => {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a run-owned fixture and read-only index', () => {
    expect(validRequest(request)).toBe(true);
    const dottedId = 'v2.' + 'a'.repeat(77);
    expect(
      validRequest({
        ...request,
        runId: dottedId,
        relative: 'checks/check-' + dottedId + '.md',
        expectMarker: 'INPUT=' + dottedId,
        appendMarker: 'EDIT=' + dottedId,
      }),
    ).toBe(true);
    expect(validRequest({ ...request, check: 'read-marker', relative: 'INDEX.md' })).toBe(true);
    for (const relative of [
      'INDEX.md',
      'references/existing.md',
      '../test-' + runId + '.md',
      '/test-' + runId + '.md',
    ]) {
      expect(validRequest({ ...request, relative })).toBe(false);
    }
    expect(validRequest({ ...request, appendMarker: 'anything\n' + runId })).toBe(false);
    expect(validRequest({ ...request, check: 'deny-path', containerPath: '/workspace/extra/unused' })).toBe(true);
    expect(validRequest({ ...request, check: 'deny-path', containerPath: '/etc' })).toBe(false);
  });

  it('appends exactly once across retries and rejects duplicated markers', () => {
    expect(checkFile(fd, request)).toBe(true);
    expect(checkFile(fd, request)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(request.expectMarker + '\n' + request.appendMarker + '\n');
    writeFileSync(file, request.expectMarker + '\n' + (request.appendMarker + '\n').repeat(2));
    expect(checkFile(fd, request)).toBe(false);
  });

  it('leaves a file belonging to another run untouched', () => {
    const another = 'PREFIX' + request.expectMarker + '\n' + request.expectMarker + '-other\n';
    writeFileSync(file, another);
    expect(checkFile(fd, request)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(another);
  });

  it('refuses a multiply-linked file before any write', () => {
    linkSync(file, path.join(dir, 'alias.md'));
    expect(() => checkFile(fd, request)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(request.expectMarker + '\n');
  });

  it('accepts loopback plus only Docker Desktop dormant kernel tunnels', () => {
    expect(networkIsIsolated(networkReader({ lo: loopback }))).toBe(true);
    expect(
      networkIsIsolated(
        networkReader({
          lo: loopback,
          erspan0: { type: '1', flags: '0x1002', operstate: 'down' },
          gre0: { type: '778', flags: '0x80', operstate: 'down' },
          gretap0: { type: '1', flags: '0x1002', operstate: 'down' },
          ip6_vti0: { type: '769', flags: '0x80', operstate: 'down' },
          ip6gre0: { type: '823', flags: '0x80', operstate: 'down' },
          ip6tnl0: { type: '769', flags: '0x80', operstate: 'down' },
          ip_vti0: { type: '768', flags: '0x80', operstate: 'down' },
          sit0: { type: '776', flags: '0x80', operstate: 'down' },
          tunl0: { type: '768', flags: '0x80', operstate: 'down' },
        }),
      ),
    ).toBe(true);
  });

  it('rejects ordinary or activated non-loopback interfaces fail-closed', () => {
    expect(
      networkIsIsolated(
        networkReader({
          lo: loopback,
          eth0: { type: '1', flags: '0x1003', operstate: 'up' },
        }),
      ),
    ).toBe(false);
    expect(
      networkIsIsolated(
        networkReader({
          lo: loopback,
          eth0: { type: '1', flags: '0x1002', operstate: 'down' },
        }),
      ),
    ).toBe(false);
    expect(
      networkIsIsolated(
        networkReader({
          lo: loopback,
          gre0: { type: '778', flags: '0x81', operstate: 'up' },
        }),
      ),
    ).toBe(false);
  });
});
