import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonPushFileToRawHandler } from './deshi_daemon_push_file_to_raw.js';

describe('daemonPushFileToRawHandler', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.DESHI_DAEMON_URL;
  const originalSecret = process.env.DESHI_DAEMON_DEVICE_SECRET;

  beforeEach(() => {
    process.env.DESHI_DAEMON_URL = 'http://localhost:3100';
    vi.stubEnv('BOSWELL_DAEMON_URL', undefined);
    vi.stubEnv('BOSWELL_DAEMON_DEVICE_SECRET', undefined);
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'test-secret';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.DESHI_DAEMON_URL;
    else process.env.DESHI_DAEMON_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    else process.env.DESHI_DAEMON_DEVICE_SECRET = originalSecret;
  });

  const helloBuf = Buffer.from('hello world');
  const helloB64 = helloBuf.toString('base64');
  const helloSha = createHash('sha256').update(helloBuf).digest('hex');

  function mockOkUpload(
    body: Record<string, unknown> = {
      ok: true,
      path: 'raw/inbox/nanoclaw/2026-06-10/whitepaper.pdf',
      sha256: helloSha,
      size: helloBuf.length,
      outcome: 'created',
    },
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function mockErrUpload(status: number, text: string): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => ({ ok: false, error: text }),
      text: async () => text,
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('POST /files/upload を multipart + Bearer 付きで叩き、ok 形式を返す', async () => {
    const fetchMock = mockOkUpload();

    const result = await daemonPushFileToRawHandler({
      file_b64: helloB64,
      dest_subpath: 'inbox/nanoclaw/2026-06-10/whitepaper.pdf',
      sha256: helloSha,
      source: 'nanoclaw',
    });

    expect(result).toEqual({
      ok: true,
      path: 'raw/inbox/nanoclaw/2026-06-10/whitepaper.pdf',
      sha256: helloSha,
      size: helloBuf.length,
      outcome: 'created',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/files/upload');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret:nanoclaw');
    // body は FormData インスタンスである必要がある (fetch が multipart 化する)
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('dest_subpath')).toBe('inbox/nanoclaw/2026-06-10/whitepaper.pdf');
    expect(form.get('sha256')).toBe(helloSha);
    expect(form.get('source')).toBe('nanoclaw');
    // overwrite は未指定なので field なし
    expect(form.get('overwrite')).toBeNull();
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
  });

  it('overwrite=true を field として乗せる', async () => {
    const fetchMock = mockOkUpload({
      ok: true,
      path: 'raw/outputs/2026-06-10-x/result.html',
      sha256: helloSha,
      size: helloBuf.length,
      outcome: 'overwritten',
    });

    await daemonPushFileToRawHandler({
      file_b64: helloB64,
      dest_subpath: 'outputs/2026-06-10-x/result.html',
      sha256: helloSha,
      overwrite: true,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get('overwrite')).toBe('true');
    expect(form.get('source')).toBeNull();
  });

  it('file_b64 が無いとエラー', async () => {
    await expect(
      daemonPushFileToRawHandler({
        dest_subpath: 'inbox/nanoclaw/2026-06-10/x.txt',
        sha256: helloSha,
      }),
    ).rejects.toThrow(/file_b64 is required/);
  });

  it('dest_subpath が無いとエラー', async () => {
    await expect(
      daemonPushFileToRawHandler({
        file_b64: helloB64,
        sha256: helloSha,
      }),
    ).rejects.toThrow(/dest_subpath is required/);
  });

  it('sha256 が hex 64 文字でないとエラー', async () => {
    await expect(
      daemonPushFileToRawHandler({
        file_b64: helloB64,
        dest_subpath: 'inbox/nanoclaw/2026-06-10/x.txt',
        sha256: 'notahex',
      }),
    ).rejects.toThrow(/sha256 must be a 64-character/);
  });

  it('DESHI_DAEMON_DEVICE_SECRET 未設定だとエラー', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    await expect(
      daemonPushFileToRawHandler({
        file_b64: helloB64,
        dest_subpath: 'inbox/nanoclaw/2026-06-10/x.txt',
        sha256: helloSha,
      }),
    ).rejects.toThrow(/BOSWELL_DAEMON_DEVICE_SECRET \(or legacy DESHI_DAEMON_DEVICE_SECRET\) is not set/);
  });

  it('daemon 4xx をエラーとして透過する (sha256 mismatch 等)', async () => {
    mockErrUpload(400, 'sha256 mismatch');
    await expect(
      daemonPushFileToRawHandler({
        file_b64: helloB64,
        dest_subpath: 'inbox/nanoclaw/2026-06-10/x.txt',
        sha256: helloSha,
      }),
    ).rejects.toThrow(/sha256 mismatch/);
  });

  it('daemon 409 (outputs 衝突) をエラーとして透過する', async () => {
    mockErrUpload(409, 'output exists, pass overwrite=true to replace');
    await expect(
      daemonPushFileToRawHandler({
        file_b64: helloB64,
        dest_subpath: 'outputs/2026-06-10-x/result.html',
        sha256: helloSha,
      }),
    ).rejects.toThrow(/output exists/);
  });

  it('source 空文字列は弾く', async () => {
    await expect(
      daemonPushFileToRawHandler({
        file_b64: helloB64,
        dest_subpath: 'inbox/nanoclaw/2026-06-10/x.txt',
        sha256: helloSha,
        source: '',
      }),
    ).rejects.toThrow(/source must be a non-empty string/);
  });

  it('overwrite が boolean でないと弾く', async () => {
    await expect(
      daemonPushFileToRawHandler({
        file_b64: helloB64,
        dest_subpath: 'inbox/nanoclaw/2026-06-10/x.txt',
        sha256: helloSha,
        overwrite: 'true',
      }),
    ).rejects.toThrow(/overwrite must be a boolean/);
  });

  it('file_b64 が空文字 decode で 0 byte の場合エラー', async () => {
    await expect(
      daemonPushFileToRawHandler({
        file_b64: '====', // base64 decode で empty
        dest_subpath: 'inbox/nanoclaw/2026-06-10/x.txt',
        sha256: helloSha,
      }),
    ).rejects.toThrow(/decoded to empty buffer/);
  });
});
