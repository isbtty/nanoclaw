import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../post-deshi-ack.js', () => ({ postDeshiRunAck: vi.fn(() => true) }));

import { daemonPollUntilDoneHandler, type JobStatusResponse } from './deshi_daemon_poll_until_done.js';
import { postDeshiRunAck } from '../post-deshi-ack.js';
import { _resetAckCacheForTests, putJobAck } from '../ack-cache.js';

const DAEMON_RESTARTED_SENTINEL = 'daemon が再起動したため、この job の実行状態は失われました。';
const CHANNEL_CTX = { channel: 'telegram', platformId: 'tg-1', threadId: 'thr-1' };

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

  const originalAckThreshold = process.env.DESHI_RUN_ACK_THRESHOLD_MS;

  beforeEach(() => {
    delete process.env.BOSWELL_DAEMON_URL;
    delete process.env.BOSWELL_DAEMON_DEVICE_SECRET;
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'test-secret';
    process.env.DESHI_DAEMON_URL = 'http://localhost:3100';
    vi.mocked(postDeshiRunAck).mockClear();
    _resetAckCacheForTests();
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
    if (originalAckThreshold === undefined) {
      delete process.env.DESHI_RUN_ACK_THRESHOLD_MS;
    } else {
      process.env.DESHI_RUN_ACK_THRESHOLD_MS = originalAckThreshold;
    }
    vi.useRealTimers();
  });

  describe('中間 ack (#423)', () => {
    it('fast job (1 回目 completed) は ack を出さない', async () => {
      process.env.DESHI_RUN_ACK_THRESHOLD_MS = '50';
      const fetchMock = mockResponseSequence([{ status: 'completed', success: true, result: 'ok' }]);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await daemonPollUntilDoneHandler({ jobId: 'JOB1', channelContext: CHANNEL_CTX });

      expect(postDeshiRunAck).not.toHaveBeenCalled();
    });

    it('slow job (閾値超過 pending) で ack を 1 回だけ出す', async () => {
      vi.useFakeTimers();
      process.env.DESHI_RUN_ACK_THRESHOLD_MS = '50';
      const fetchMock = mockResponseSequence([
        { status: 'pending', retryAfterMs: 100 },
        { status: 'pending', retryAfterMs: 100 },
        { status: 'pending', retryAfterMs: 100 },
        { status: 'completed', success: true, result: 'done' },
      ]);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const promise = daemonPollUntilDoneHandler({ jobId: 'JOB1', channelContext: CHANNEL_CTX });
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      const res = await promise;

      expect(res.status).toBe('completed');
      expect(postDeshiRunAck).toHaveBeenCalledTimes(1);
      // haiku 要約は putJobAck されていないので overrideText は undefined
      expect(postDeshiRunAck).toHaveBeenCalledWith(CHANNEL_CTX, undefined);
    });

    it('channelContext が無ければ slow でも ack を出さない', async () => {
      vi.useFakeTimers();
      process.env.DESHI_RUN_ACK_THRESHOLD_MS = '50';
      const fetchMock = mockResponseSequence([
        { status: 'pending', retryAfterMs: 100 },
        { status: 'pending', retryAfterMs: 100 },
        { status: 'completed', success: true },
      ]);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const promise = daemonPollUntilDoneHandler({ jobId: 'JOB1' });
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(postDeshiRunAck).not.toHaveBeenCalled();
    });
  });

  describe('中間 ack 動的化 (haiku 要約の override)', () => {
    it('haiku 要約 (ack-cache) があれば overrideText として渡す', async () => {
      vi.useFakeTimers();
      process.env.DESHI_RUN_ACK_THRESHOLD_MS = '50';
      putJobAck('JOB2', '資料を作ってます ✏️');

      const fetchMock = mockResponseSequence([
        { status: 'pending', retryAfterMs: 100 },
        { status: 'pending', retryAfterMs: 100 },
        { status: 'completed', success: true },
      ]);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const promise = daemonPollUntilDoneHandler({ jobId: 'JOB2', channelContext: CHANNEL_CTX });
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(postDeshiRunAck).toHaveBeenCalledTimes(1);
      expect(postDeshiRunAck).toHaveBeenCalledWith(CHANNEL_CTX, '資料を作ってます ✏️');
    });

    it('postDeshiRunAck が cooldown で suppress (false) を返した場合、次 poll で要約到着後にリトライする', async () => {
      vi.useFakeTimers();
      process.env.DESHI_RUN_ACK_THRESHOLD_MS = '50';
      // postDeshiRunAck の挙動を実装に合わせて模倣する:
      // - override 無し + cooldown 内: false (suppress)
      // - override 有り: true (送信)
      vi.mocked(postDeshiRunAck).mockImplementation((_ctx, overrideText) => {
        return !!(overrideText && overrideText.trim() !== '');
      });

      let pollNo = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        pollNo++;
        // 3 回目の poll で haiku 要約が到着
        if (pollNo === 3) putJobAck('JOB2', '田中さんを調べてます 🔎');
        return {
          ok: true,
          status: 200,
          json: async () =>
            pollNo >= 5 ? { status: 'completed', success: true } : { status: 'pending', retryAfterMs: 100 },
          text: async () => '',
        } as unknown as Response;
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const promise = daemonPollUntilDoneHandler({ jobId: 'JOB2', channelContext: CHANNEL_CTX });
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(100);
      await promise;

      // 要約到着前の poll は postDeshiRunAck が false を返すので何度か空打ちされ、
      // 要約到着後に override 付きで送信成功 → 最後の呼び出しは override 引数を持つ
      const calls = vi.mocked(postDeshiRunAck).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toEqual([CHANNEL_CTX, '田中さんを調べてます 🔎']);
    });
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
      /BOSWELL_DAEMON_DEVICE_SECRET \(or legacy DESHI_DAEMON_DEVICE_SECRET\) is not set/,
    );
  });

  it('jobId が無い body は throw する (validation)', async () => {
    await expect(daemonPollUntilDoneHandler({} as unknown)).rejects.toThrow(/jobId is required/);
  });

  it('jobId が空文字 は throw する (validation)', async () => {
    await expect(daemonPollUntilDoneHandler({ jobId: '' } as unknown)).rejects.toThrow(/jobId is required/);
  });

  it('404 (job evicted) は throw せず terminal failed を返す (#451)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"error":"job not found"}',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await daemonPollUntilDoneHandler({ jobId: 'NOPE' });

    expect(res.status).toBe('failed');
    expect(res.success).toBe(false);
    expect(res.jobEvicted).toBe(true);
    expect(res.error).toMatch(/job evicted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pending を経た後の 404 でも terminal failed (jobEvicted) を返す', async () => {
    vi.useFakeTimers();
    let i = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      i++;
      if (i <= 2) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'pending', retryAfterMs: 100 }),
          text: async () => '',
        } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => 'job not found' } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = daemonPollUntilDoneHandler({ jobId: 'JOB1' });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    const res = await promise;

    expect(res.status).toBe('failed');
    expect(res.jobEvicted).toBe(true);
    // 2 回の pending poll をカウント済み (404 自体は pollCount に含めない)
    expect(res.pollCount).toBe(2);
  });

  it('404 以外の non-2xx は terminal 化せず throw する (発生元へ即エラー告知)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonPollUntilDoneHandler({ jobId: 'NOPE' })).rejects.toThrow(
      /deshi daemon \/jobs failed: 500 internal error/,
    );
  });
});
