import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from '../env.js';
import { fetchDeshiDelegationFragment } from './fetch-delegation-fragment.js';

// readEnvFile reads the real `.env` from process.cwd(); mock it so tests drive
// the `.env` fallback deterministically (default: empty, so process.env wins).
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
const readEnvFileMock = vi.mocked(readEnvFile);

describe('fetchDeshiDelegationFragment', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.DESHI_DAEMON_URL;
  const originalSecret = process.env.DESHI_DAEMON_DEVICE_SECRET;

  beforeEach(() => {
    readEnvFileMock.mockReturnValue({});
    process.env.DESHI_DAEMON_URL = 'http://localhost:3100';
    vi.stubEnv('BOSWELL_DAEMON_URL', undefined);
    vi.stubEnv('BOSWELL_DAEMON_DEVICE_SECRET', undefined);
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'test-secret';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('GET /nanoclaw-fragment を Bearer 付きで叩き、本文を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '# delegation policy\n\nbody\n',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchDeshiDelegationFragment();
    expect(result).toBe('# delegation policy\n\nbody\n');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/nanoclaw-fragment');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret:nanoclaw');
  });

  it('DESHI_DAEMON_URL で daemon URL を差し替えできる', async () => {
    process.env.DESHI_DAEMON_URL = 'http://daemon.example:9000';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'body',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchDeshiDelegationFragment();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://daemon.example:9000/nanoclaw-fragment');
  });

  it('DESHI_DAEMON_DEVICE_SECRET が未設定なら throw する', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    await expect(fetchDeshiDelegationFragment()).rejects.toThrow(
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'body',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchDeshiDelegationFragment();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/nanoclaw-fragment');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer from-dotenv:nanoclaw');
  });

  it('process.env が .env fallback より優先される', async () => {
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'from-process-env';
    readEnvFileMock.mockReturnValue({ DESHI_DAEMON_DEVICE_SECRET: 'from-dotenv' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'body',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchDeshiDelegationFragment();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer from-process-env:nanoclaw');
  });

  it('secret が process.env にも .env にも無ければ throw する', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    readEnvFileMock.mockReturnValue({});
    await expect(fetchDeshiDelegationFragment()).rejects.toThrow(
      /BOSWELL_DAEMON_DEVICE_SECRET \(or legacy DESHI_DAEMON_DEVICE_SECRET\) is not set/,
    );
  });

  it('non-2xx の場合は status と body 込みで throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'nanoclaw-fragment file not found',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchDeshiDelegationFragment()).rejects.toThrow(
      /deshi daemon \/nanoclaw-fragment failed: 404 nanoclaw-fragment file not found/,
    );
  });

  it('fetch がネットワークエラーした場合は throw が propagate する', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchDeshiDelegationFragment()).rejects.toThrow('ECONNREFUSED');
  });

  it('AbortSignal を fetch に透過する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'body',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    await fetchDeshiDelegationFragment({ signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});
