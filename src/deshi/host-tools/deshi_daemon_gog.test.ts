import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { daemonGogHandler } from './deshi_daemon_gog.js';

describe('daemonGogHandler', () => {
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

  const validPayload = {
    ok: true,
    subcommand: 'calendar.events',
    stdout: 'ID\tSTART\tEND\tSUMMARY\n',
    stderr: '',
    exitCode: 0,
  };

  function mockOk(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('POST /gog を Bearer + JSON body 付きで叩く', async () => {
    const fetchMock = mockOk(validPayload);

    const result = await daemonGogHandler({
      subcommand: 'calendar.events',
      args: ['--days', '1', '--plain'],
    });

    expect(result).toEqual(validPayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/gog');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret:nanoclaw');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      subcommand: 'calendar.events',
      args: ['--days', '1', '--plain'],
    });
  });

  it('args 未指定なら body に args フィールドを乗せない (daemon default に従う)', async () => {
    const fetchMock = mockOk({ ...validPayload, stdout: '' });

    await daemonGogHandler({ subcommand: 'calendar.calendars' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ subcommand: 'calendar.calendars' });
  });

  it('timeout を指定すると body に乗る', async () => {
    const fetchMock = mockOk(validPayload);

    await daemonGogHandler({ subcommand: 'calendar.events', timeout: 5000 });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({ timeout: 5000 });
  });

  it('DESHI_DAEMON_URL でエンドポイントを差し替えできる', async () => {
    process.env.DESHI_DAEMON_URL = 'http://daemon.example:9000';
    const fetchMock = mockOk(validPayload);

    await daemonGogHandler({ subcommand: 'calendar.events' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://daemon.example:9000/gog');
  });

  // ── validation ──────────────────────────────────────────────────────────

  it('subcommand 必須', async () => {
    await expect(daemonGogHandler({})).rejects.toThrow(/subcommand is required/);
    await expect(daemonGogHandler({ subcommand: '' })).rejects.toThrow(/subcommand is required/);
    await expect(daemonGogHandler({ subcommand: 123 })).rejects.toThrow(/subcommand is required/);
  });

  it('args が文字列配列でないと throw', async () => {
    await expect(daemonGogHandler({ subcommand: 'calendar.events', args: 'no' })).rejects.toThrow(
      /args must be a string array/,
    );
    await expect(daemonGogHandler({ subcommand: 'calendar.events', args: [1, 2] })).rejects.toThrow(
      /args must be a string array/,
    );
  });

  it('timeout が範囲外だと throw', async () => {
    await expect(daemonGogHandler({ subcommand: 'calendar.events', timeout: 0 })).rejects.toThrow(/timeout must be/);
    await expect(daemonGogHandler({ subcommand: 'calendar.events', timeout: 999 })).rejects.toThrow(/timeout must be/);
    await expect(daemonGogHandler({ subcommand: 'calendar.events', timeout: 300001 })).rejects.toThrow(
      /timeout must be/,
    );
    await expect(daemonGogHandler({ subcommand: 'calendar.events', timeout: '5000' })).rejects.toThrow(
      /timeout must be/,
    );
  });

  it('body が object でないと throw', async () => {
    await expect(daemonGogHandler(null)).rejects.toThrow(/JSON object/);
    await expect(daemonGogHandler('hi')).rejects.toThrow(/JSON object/);
  });

  // ── env / daemon errors ─────────────────────────────────────────────────

  it('新旧キーが両方設定されている機では、新しい BOSWELL_ 側の接続情報を使う', async () => {
    process.env.BOSWELL_DAEMON_URL = 'http://boswell.example:9000';
    process.env.BOSWELL_DAEMON_DEVICE_SECRET = 'boswell-secret';
    const fetchMock = mockOk(validPayload);

    await daemonGogHandler({ subcommand: 'calendar.events' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://boswell.example:9000/gog');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer boswell-secret:nanoclaw');
  });

  it('device secret がどちらのキーでも設定されていなければ throw', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    await expect(daemonGogHandler({ subcommand: 'calendar.events' })).rejects.toThrow(
      /BOSWELL_DAEMON_DEVICE_SECRET \(or legacy DESHI_DAEMON_DEVICE_SECRET\) is not set/,
    );
  });

  it('daemon 403 (whitelist 違反) は status + body を含めて throw', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => '{"error":"subcommand not allowed: calendar.delete"}',
    } as unknown as Response) as unknown as typeof fetch;

    await expect(daemonGogHandler({ subcommand: 'calendar.delete' })).rejects.toThrow(/deshi daemon \/gog failed: 403/);
  });

  it('daemon 502 (subprocess 非ゼロ exit) は status + body を含めて throw', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => '{"ok":false,"subcommand":"calendar.event","exitCode":1,"stderr":"not found"}',
    } as unknown as Response) as unknown as typeof fetch;

    await expect(daemonGogHandler({ subcommand: 'calendar.event', args: ['primary', 'bogusId'] })).rejects.toThrow(
      /deshi daemon \/gog failed: 502/,
    );
  });

  it('fetch ネットワークエラーは propagate', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(daemonGogHandler({ subcommand: 'calendar.events' })).rejects.toThrow('ECONNREFUSED');
  });

  it('不正なレスポンス shape は throw', async () => {
    mockOk({ ok: true, subcommand: 'calendar.events' }); // missing stdout/stderr/exitCode
    await expect(daemonGogHandler({ subcommand: 'calendar.events' })).rejects.toThrow(/unexpected body/);
  });

  it('ok: false が返ってきた場合も unexpected body 扱い', async () => {
    mockOk({ ok: false, subcommand: 'calendar.events', stdout: '', stderr: '', exitCode: 1 });
    await expect(daemonGogHandler({ subcommand: 'calendar.events' })).rejects.toThrow(/unexpected body/);
  });
});
