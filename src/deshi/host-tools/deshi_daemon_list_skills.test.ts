import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonListSkillsHandler } from './deshi_daemon_list_skills.js';

describe('daemonListSkillsHandler', () => {
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

  it('GET /skills を Bearer 付きで叩き、ok 形式で skills を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        skills: [
          { name: 'sync', description: 'sync skill' },
          { name: 'ingest', description: 'ingest skill' },
        ],
      }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await daemonListSkillsHandler({});

    expect(result).toEqual({
      ok: true,
      schemaVersion: 1,
      skills: [
        { name: 'sync', description: 'sync skill' },
        { name: 'ingest', description: 'ingest skill' },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/skills');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret:nanoclaw');
  });

  it('argumentHint を含む skill をそのまま透過する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        skills: [{ name: 'ingest', description: 'x', argumentHint: '[source]' }],
      }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await daemonListSkillsHandler({});
    expect(result.skills[0]).toEqual({
      name: 'ingest',
      description: 'x',
      argumentHint: '[source]',
    });
  });

  it('skills が空配列でも 200 を透過する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, skills: [] }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await daemonListSkillsHandler({});
    expect(result.skills).toEqual([]);
  });

  it('DESHI_DAEMON_URL で daemon URL を差し替えできる', async () => {
    process.env.DESHI_DAEMON_URL = 'http://daemon.example:9000';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, skills: [] }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await daemonListSkillsHandler({});
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://daemon.example:9000/skills');
  });

  it('DESHI_DAEMON_DEVICE_SECRET が未設定なら throw する', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    await expect(daemonListSkillsHandler({})).rejects.toThrow(
      /BOSWELL_DAEMON_DEVICE_SECRET \(or legacy DESHI_DAEMON_DEVICE_SECRET\) is not set/,
    );
  });

  it('non-2xx の場合は error を throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
      json: async () => ({}),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonListSkillsHandler({})).rejects.toThrow(/deshi daemon \/skills failed: 401 unauthorized/);
  });

  it('schemaVersion が無いレスポンスは throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ skills: [] }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonListSkillsHandler({})).rejects.toThrow(/returned unexpected body/);
  });

  it('skills が配列でないレスポンスは throw する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, skills: 'not-an-array' }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonListSkillsHandler({})).rejects.toThrow(/returned unexpected body/);
  });

  it('fetch がネットワークエラーした場合は throw が propagate する', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(daemonListSkillsHandler({})).rejects.toThrow('ECONNREFUSED');
  });

  it('body は読み捨てる (引数の有無で挙動が変わらない)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, skills: [] }),
      text: async () => '',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await daemonListSkillsHandler({ unrelated: 'field' });
    await daemonListSkillsHandler(undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
