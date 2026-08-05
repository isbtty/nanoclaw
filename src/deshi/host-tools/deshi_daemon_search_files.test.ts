import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonSearchFilesHandler } from './deshi_daemon_search_files.js';

describe('daemonSearchFilesHandler', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.DESHI_DAEMON_URL;
  const originalSecret = process.env.DESHI_DAEMON_DEVICE_SECRET;

  beforeEach(() => {
    process.env.DESHI_DAEMON_URL = 'http://localhost:3100';
    delete process.env.BOSWELL_DAEMON_URL;
    delete process.env.BOSWELL_DAEMON_DEVICE_SECRET;
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.DESHI_DAEMON_URL;
    else process.env.DESHI_DAEMON_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    else process.env.DESHI_DAEMON_DEVICE_SECRET = originalSecret;
  });

  const validPayload = {
    query: 'example',
    results: [
      { path: 'projects/foo.md', name: 'foo.md', score: 0.7, snippet: '...' },
      { path: 'meetings/bar.md', name: 'bar.md', score: 0.6, snippet: 'bar' },
    ],
    totalCount: 2,
    indexedAt: '2026-05-26T04:00:00.000Z',
  };

  function mockOk(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('GET /files/search を Bearer 付きで叩き、ok 形式で結果を返す', async () => {
    const fetchMock = mockOk(validPayload);

    const result = await daemonSearchFilesHandler({ query: 'example' });

    expect(result).toEqual({
      ok: true,
      query: 'example',
      results: validPayload.results,
      totalCount: 2,
      indexedAt: '2026-05-26T04:00:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/files/search?q=example');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret:nanoclaw');
  });

  it('limit を指定すると query string に乗る', async () => {
    const fetchMock = mockOk(validPayload);

    await daemonSearchFilesHandler({ query: 'example', limit: 5 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/files/search?q=example&limit=5');
  });

  it('limit 未指定なら query string にも乗せない (daemon default に従う)', async () => {
    const fetchMock = mockOk(validPayload);

    await daemonSearchFilesHandler({ query: 'example' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('limit=');
  });

  it('日本語クエリは正しく URL encode される', async () => {
    const fetchMock = mockOk({ ...validPayload, query: '会議' });

    await daemonSearchFilesHandler({ query: '会議' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/files/search?q=%E4%BC%9A%E8%AD%B0');
  });

  it('DESHI_DAEMON_URL で daemon URL を差し替えできる', async () => {
    process.env.DESHI_DAEMON_URL = 'http://daemon.example:9000';
    const fetchMock = mockOk(validPayload);

    await daemonSearchFilesHandler({ query: 'x' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.example:9000/files/search?q=x');
  });

  // ── validation ──────────────────────────────────────────────────────────

  it('query が無いと throw する', async () => {
    await expect(daemonSearchFilesHandler({})).rejects.toThrow(/query is required/);
  });

  it('query が空文字 / whitespace のみだと throw する', async () => {
    await expect(daemonSearchFilesHandler({ query: '' })).rejects.toThrow(/query is required/);
    await expect(daemonSearchFilesHandler({ query: '   ' })).rejects.toThrow(/query is required/);
  });

  it('query が文字列でないと throw する', async () => {
    await expect(daemonSearchFilesHandler({ query: 123 })).rejects.toThrow(/query is required/);
  });

  it('limit が範囲外だと throw する', async () => {
    await expect(daemonSearchFilesHandler({ query: 'x', limit: 0 })).rejects.toThrow(/limit must be/);
    await expect(daemonSearchFilesHandler({ query: 'x', limit: 101 })).rejects.toThrow(/limit must be/);
    await expect(daemonSearchFilesHandler({ query: 'x', limit: 1.5 })).rejects.toThrow(/limit must be/);
    await expect(daemonSearchFilesHandler({ query: 'x', limit: 'big' })).rejects.toThrow(/limit must be/);
  });

  it('body が object でないと throw する', async () => {
    await expect(daemonSearchFilesHandler(null)).rejects.toThrow(/JSON object/);
    await expect(daemonSearchFilesHandler('hello')).rejects.toThrow(/JSON object/);
  });

  // ── env / network errors ─────────────────────────────────────────────────

  it('DESHI_DAEMON_DEVICE_SECRET が未設定なら throw する', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    await expect(daemonSearchFilesHandler({ query: 'x' })).rejects.toThrow(
      /BOSWELL_DAEMON_DEVICE_SECRET \(or legacy DESHI_DAEMON_DEVICE_SECRET\) is not set/,
    );
  });

  it('non-2xx の場合は status + body を含めて throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '{"error":"qmd is not installed on server"}',
      json: async () => ({}),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonSearchFilesHandler({ query: 'x' })).rejects.toThrow(/deshi daemon \/files\/search failed: 503/);
  });

  it('fetch がネットワークエラーした場合は throw が propagate する', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonSearchFilesHandler({ query: 'x' })).rejects.toThrow('ECONNREFUSED');
  });

  it('totalCount が無いレスポンスは throw する', async () => {
    mockOk({ query: 'x', results: [], indexedAt: '2026-05-26T04:00:00.000Z' });
    await expect(daemonSearchFilesHandler({ query: 'x' })).rejects.toThrow(/unexpected body/);
  });

  it('results が配列でないレスポンスは throw する', async () => {
    mockOk({ query: 'x', results: 'nope', totalCount: 0, indexedAt: '2026-05-26T04:00:00.000Z' });
    await expect(daemonSearchFilesHandler({ query: 'x' })).rejects.toThrow(/unexpected body/);
  });
});
