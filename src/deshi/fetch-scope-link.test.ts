import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from '../env.js';
import { fetchDeshiScopeLink } from './fetch-scope-link.js';

// readEnvFile reads the real `.env` from process.cwd(); mock it so tests drive
// the `.env` fallback deterministically (default: empty, so process.env wins).
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
const readEnvFileMock = vi.mocked(readEnvFile);

describe('fetchDeshiScopeLink', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.DESHI_DAEMON_URL;
  const originalSecret = process.env.DESHI_DAEMON_DEVICE_SECRET;

  beforeEach(() => {
    readEnvFileMock.mockReturnValue({});
    process.env.DESHI_DAEMON_URL = 'http://localhost:3100';
    delete process.env.BOSWELL_DAEMON_URL;
    delete process.env.BOSWELL_DAEMON_DEVICE_SECRET;
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) {
      delete process.env.DESHI_DAEMON_URL;
    } else {
      process.env.DESHI_DAEMON_URL = originalUrl;
    }
    if (originalSecret === undefined) {
      delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    } else {
      process.env.DESHI_DAEMON_DEVICE_SECRET = originalSecret;
    }
  });

  function okResponse(body: { url: string; token: string }) {
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }

  it('POST /knowledge/scope-link を Bearer + channelId 付きで叩き、{url, token} を返す', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ url: 'https://u.deshi.jp/scope-ui?token=abc', token: 'abc' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchDeshiScopeLink('line:U123');
    expect(result).toEqual({ url: 'https://u.deshi.jp/scope-ui?token=abc', token: 'abc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/knowledge/scope-link');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret:nanoclaw');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ channelId: 'line:U123' });
  });

  it('DESHI_DAEMON_URL で daemon URL を差し替えできる', async () => {
    process.env.DESHI_DAEMON_URL = 'http://daemon.example:9000';
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ url: 'u', token: 't' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchDeshiScopeLink('telegram:42');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://daemon.example:9000/knowledge/scope-link');
  });

  it('DESHI_DAEMON_DEVICE_SECRET が未設定なら throw する', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    await expect(fetchDeshiScopeLink('line:U1')).rejects.toThrow(
      /BOSWELL_DAEMON_DEVICE_SECRET \(or legacy DESHI_DAEMON_DEVICE_SECRET\) is not set/,
    );
  });

  it('process.env に secret が無くても .env fallback から拾う (launchd plist に env が無いケース)', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    delete process.env.DESHI_DAEMON_URL;
    readEnvFileMock.mockReturnValue({
      DESHI_DAEMON_URL: 'http://localhost:3100',
      DESHI_DAEMON_DEVICE_SECRET: 'from-dotenv',
    });
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ url: 'u', token: 't' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchDeshiScopeLink('line:U1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/knowledge/scope-link');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer from-dotenv:nanoclaw');
  });

  it('process.env が .env fallback より優先される', async () => {
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'from-process-env';
    readEnvFileMock.mockReturnValue({ DESHI_DAEMON_DEVICE_SECRET: 'from-dotenv' });
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ url: 'u', token: 't' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchDeshiScopeLink('line:U1');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer from-process-env:nanoclaw');
  });

  it('non-2xx の場合は status と body 込みで throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchDeshiScopeLink('line:U1')).rejects.toThrow(
      /deshi daemon \/knowledge\/scope-link failed: 401 Unauthorized/,
    );
  });

  it('AbortSignal を fetch に透過する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ url: 'u', token: 't' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    await fetchDeshiScopeLink('line:U1', { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});
