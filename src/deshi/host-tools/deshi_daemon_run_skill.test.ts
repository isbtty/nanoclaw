import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonRunSkillHandler, type DaemonRunSkillRequest } from './deshi_daemon_run_skill.js';

const validBody: DaemonRunSkillRequest = {
  skillName: 'sync',
  channelContext: {
    channel: 'telegram',
    platformId: 'u-1',
    threadId: 'dm',
    isGroup: false,
  },
};

describe('daemonRunSkillHandler', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.DESHI_DAEMON_URL;

  beforeEach(() => {
    process.env.DESHI_DAEMON_URL = 'http://localhost:3100';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) {
      delete process.env.DESHI_DAEMON_URL;
    } else {
      process.env.DESHI_DAEMON_URL = originalUrl;
    }
  });

  it('POST /run に input + channelContext を渡し、202 のレスポンスを ok 形式で返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ jobId: 'JOB1', threadId: 'T1' }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await daemonRunSkillHandler(validBody);

    expect(result).toEqual({ ok: true, jobId: 'JOB1', threadId: 'T1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/run');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      input: string;
      channelContext: unknown;
    };
    expect(body.input).toBe('/sync');
    expect(body.channelContext).toEqual(validBody.channelContext);
    // POST /run は localhost auto-auth するので Authorization は送らない
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('args が指定された場合は input に追記する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: 'JOB2', threadId: 'T2' }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await daemonRunSkillHandler({ ...validBody, args: '--full' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { input: string };
    expect(body.input).toBe('/sync --full');
  });

  it('DESHI_DAEMON_URL で daemon URL を差し替えできる', async () => {
    process.env.DESHI_DAEMON_URL = 'http://daemon.example:9000';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: 'X', threadId: 'Y' }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await daemonRunSkillHandler(validBody);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://daemon.example:9000/run');
  });

  it('non-2xx の場合は error を throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'internal error',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonRunSkillHandler(validBody)).rejects.toThrow(/deshi daemon \/run failed: 500 internal error/);
  });

  it('レスポンスに jobId / threadId が欠けていたら throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: 'JOB' }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonRunSkillHandler(validBody)).rejects.toThrow(/returned unexpected body/);
  });

  it('skillName が無い body は throw する (validation)', async () => {
    await expect(daemonRunSkillHandler({} as unknown)).rejects.toThrow(/skillName and channelContext are required/);
  });

  it('channelContext が無い body は throw する (validation)', async () => {
    await expect(daemonRunSkillHandler({ skillName: 'sync' } as unknown)).rejects.toThrow(
      /skillName and channelContext are required/,
    );
  });

  it('fetch がネットワークエラーした場合は throw が propagate する', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonRunSkillHandler(validBody)).rejects.toThrow('ECONNREFUSED');
  });
});
