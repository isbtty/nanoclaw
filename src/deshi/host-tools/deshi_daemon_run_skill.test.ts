import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonRunSkillHandler, type DaemonRunSkillRequest } from './deshi_daemon_run_skill.js';

const validBody: DaemonRunSkillRequest = {
  input: '今日の予定教えて',
  channelContext: {
    channel: 'telegram',
    platformId: 'u-1',
    threadId: 'dm',
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

  it('POST /run に input をそのまま渡し、202 のレスポンスを ok 形式で返す', async () => {
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
    // 自由文をそのまま渡す（skillName からの組み立てはしない）
    expect(body.input).toBe('今日の予定教えて');
    expect(body.channelContext).toEqual(validBody.channelContext);
    // POST /run は localhost auto-auth するので Authorization は送らない
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('skill 名つきの自由文 ("/boswell-sync --full") もそのまま渡す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: 'JOB2', threadId: 'T2' }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await daemonRunSkillHandler({ ...validBody, input: '/boswell-sync --full' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { input: string };
    expect(body.input).toBe('/boswell-sync --full');
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

  it('input が無い body は throw する (validation)', async () => {
    await expect(daemonRunSkillHandler({} as unknown)).rejects.toThrow(/input and channelContext are required/);
  });

  it('input が空文字の body は throw する (validation)', async () => {
    await expect(
      daemonRunSkillHandler({ input: '  ', channelContext: { channel: 'telegram', platformId: 'u-1' } } as unknown),
    ).rejects.toThrow(/input and channelContext are required/);
  });

  it('channelContext が無い body は throw する (validation)', async () => {
    await expect(daemonRunSkillHandler({ input: 'hi' } as unknown)).rejects.toThrow(
      /input and channelContext are required/,
    );
  });

  it('fetch がネットワークエラーした場合は throw が propagate する', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonRunSkillHandler(validBody)).rejects.toThrow('ECONNREFUSED');
  });

  it('threadId 欠落の channelContext (DM 等の thread を持たない channel) も受け付け、そのまま deshi へ渡す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: 'JOB3', threadId: 'T3' }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const bodyWithoutThreadId: DaemonRunSkillRequest = {
      input: 'hi',
      channelContext: { channel: 'telegram', platformId: 'telegram:8692810494' },
    };
    await daemonRunSkillHandler(bodyWithoutThreadId);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { channelContext: { threadId?: string } };
    expect(body.channelContext.threadId).toBeUndefined();
  });
});
