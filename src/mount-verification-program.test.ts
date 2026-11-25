import { closeSync, constants, linkSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { validRequest, checkFile } = createRequire(import.meta.url)(
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
});
