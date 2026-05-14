import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonPollUntilDoneHandler, type JobStatusResponse } from './deshi_daemon_poll_until_done.js';

const DAEMON_RESTARTED_SENTINEL = 'daemon が再起動したため、この job の実行状態は失われました。';

function mockResponseSequence(responses: Partial<JobStatusResponse>[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn().mockImplementation(async () => {
    const data = responses[i++] ?? { status: 'pending' };
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => '',
    } as unknown as Response;
  });
}

describe('daemonPollUntilDoneHandler', () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.DESHI_DAEMON_DEVICE_SECRET;
  const originalUrl = process.env.DESHI_DAEMON_URL;

  beforeEach(() => {
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'test-secret';
    process.env.DESHI_DAEMON_URL = 'http://localhost:3100';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) {
      delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    } else {
      process.env.DESHI_DAEMON_DEVICE_SECRET = originalSecret;
    }
    if (originalUrl === undefined) {
      delete process.env.DESHI_DAEMON_URL;
    } else {
      process.env.DESHI_DAEMON_URL = originalUrl;
    }
    vi.useRealTimers();
  });

  it('1 回目に completed が返る場合は即座に return する', async () => {
    const fetchMock = mockResponseSequence([{ status: 'completed', success: true, result: 'ok', durationMs: 100 }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await daemonPollUntilDoneHandler({ jobId: 'JOB1' });

    expect(res.status).toBe('completed');
    expect(res.result).toBe('ok');
    expect(res.daemonRestarted).toBe(false);
    expect(res.pollCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Bearer ヘッダに DESHI_DAEMON_DEVICE_SECRET を含める', async () => {
    const fetchMock = mockResponseSequence([{ status: 'completed', success: true }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await daemonPollUntilDoneHandler({ jobId: 'JOB1' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret:nanoclaw');
  });

  it('pending → pending → completed で 3 回 retry する', async () => {
    vi.useFakeTimers();
    const fetchMock = mockResponseSequence([
      { status: 'pending', retryAfterMs: 100 },
      { status: 'pending', retryAfterMs: 100 },
      { status: 'completed', success: true, result: 'done' },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = daemonPollUntilDoneHandler({ jobId: 'JOB1' });
    // sleep を進める
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    const res = await promise;

    expect(res.status).toBe('completed');
    expect(res.pollCount).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('daemon 再起動 sentinel を検出して daemonRestarted: true を返す', async () => {
    const fetchMock = mockResponseSequence([{ status: 'failed', success: false, error: DAEMON_RESTARTED_SENTINEL }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await daemonPollUntilDoneHandler({ jobId: 'JOB1' });

    expect(res.status).toBe('failed');
    expect(res.daemonRestarted).toBe(true);
    expect(res.error).toBe(DAEMON_RESTARTED_SENTINEL);
  });

  it('普通の failed では daemonRestarted は false', async () => {
    const fetchMock = mockResponseSequence([{ status: 'failed', success: false, error: 'some other error' }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await daemonPollUntilDoneHandler({ jobId: 'JOB1' });

    expect(res.status).toBe('failed');
    expect(res.daemonRestarted).toBe(false);
  });

  it('timeoutMs を超えると timedOut: true を返す (最後の pending を保持)', async () => {
    vi.useFakeTimers();
    const fetchMock = mockResponseSequence([
      { status: 'pending', retryAfterMs: 1000, progress: { message: 'first' } },
      { status: 'pending', retryAfterMs: 1000, progress: { message: 'second' } },
      { status: 'pending', retryAfterMs: 1000, progress: { message: 'third' } },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = daemonPollUntilDoneHandler({
      jobId: 'JOB1',
      timeoutMs: 2500,
    });
    await vi.advanceTimersByTimeAsync(3000);
    const res = await promise;

    expect(res.status).toBe('pending');
    expect(res.timedOut).toBe(true);
    expect(res.pollCount).toBeGreaterThanOrEqual(2);
    // 最後の pending response の progress を保持していること
    expect(res.progress).toBeDefined();
    expect(res.progress?.message).toMatch(/first|second|third/);
  });

  it('retryAfterMs が極端に大きい値でも MAX_RETRY_MS (5s) で clamp される', async () => {
    vi.useFakeTimers();
    const fetchMock = mockResponseSequence([
      { status: 'pending', retryAfterMs: 999_999 }, // 大きい
      { status: 'completed' },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = daemonPollUntilDoneHandler({ jobId: 'JOB1' });
    // 5 秒進めれば clamp により sleep が解放されるはず
    await vi.advanceTimersByTimeAsync(5000);
    const res = await promise;

    expect(res.status).toBe('completed');
    expect(res.pollCount).toBe(2);
  });

  it('retryAfterMs が 0 / 負数 でも MIN_RETRY_MS (100ms) で clamp される', async () => {
    vi.useFakeTimers();
    const fetchMock = mockResponseSequence([{ status: 'pending', retryAfterMs: 0 }, { status: 'completed' }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = daemonPollUntilDoneHandler({ jobId: 'JOB1' });
    await vi.advanceTimersByTimeAsync(100);
    const res = await promise;

    expect(res.status).toBe('completed');
  });

  it('DESHI_DAEMON_DEVICE_SECRET 未設定なら throw する', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    await expect(daemonPollUntilDoneHandler({ jobId: 'JOB1' })).rejects.toThrow(
      /DESHI_DAEMON_DEVICE_SECRET is not set/,
    );
  });

  it('jobId が無い body は throw する (validation)', async () => {
    await expect(daemonPollUntilDoneHandler({} as unknown)).rejects.toThrow(/jobId is required/);
  });

  it('jobId が空文字 は throw する (validation)', async () => {
    await expect(daemonPollUntilDoneHandler({ jobId: '' } as unknown)).rejects.toThrow(/jobId is required/);
  });

  it('non-2xx の場合は throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'job not found',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonPollUntilDoneHandler({ jobId: 'NOPE' })).rejects.toThrow(
      /deshi daemon \/jobs failed: 404 job not found/,
    );
  });
});
