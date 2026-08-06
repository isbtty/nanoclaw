import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the upstream skill-execution-notifications handler so we don't need a real DB.
// Done BEFORE importing the SUT so the mock is in place when the SUT resolves its imports.
vi.mock('../inbound/skill-execution-notifications.js', () => ({
  skillExecutionNotificationsHandler: vi.fn(),
}));
import { skillExecutionNotificationsHandler } from '../inbound/skill-execution-notifications.js';
import { daemonSendFileToChatHandler } from './deshi_daemon_send_file_to_chat.js';

describe('daemonSendFileToChatHandler', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.DESHI_DAEMON_URL;
  const originalSecret = process.env.DESHI_DAEMON_DEVICE_SECRET;

  beforeEach(() => {
    process.env.DESHI_DAEMON_URL = 'http://localhost:3100';
    vi.stubEnv('BOSWELL_DAEMON_URL', undefined);
    vi.stubEnv('BOSWELL_DAEMON_DEVICE_SECRET', undefined);
    process.env.DESHI_DAEMON_DEVICE_SECRET = 'test-secret';
    vi.mocked(skillExecutionNotificationsHandler).mockReset();
    vi.mocked(skillExecutionNotificationsHandler).mockResolvedValue({
      ok: true,
      sessionId: 'sess-x',
      messageId: 'msg-x',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.DESHI_DAEMON_URL;
    else process.env.DESHI_DAEMON_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    else process.env.DESHI_DAEMON_DEVICE_SECRET = originalSecret;
  });

  const channelContext = { channel: 'telegram', platformId: 'telegram:5292106449', threadId: 'tg:t-1' };

  function mockFilesContent(body: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  // ── happy paths ─────────────────────────────────────────────────────────

  it('utf-8 ファイルを base64 化して skillExecutionNotificationsHandler に渡す', async () => {
    const fetchMock = mockFilesContent({
      path: 'outputs/foo/bar.html',
      name: 'bar.html',
      extension: '.html',
      size: 11,
      encoding: 'utf-8',
      content: '<html>hi</html>',
    });

    const result = await daemonSendFileToChatHandler({
      path: 'outputs/foo/bar.html',
      text: 'こちらです',
      channelContext,
    });

    expect(result).toEqual({ ok: true, sessionId: 'sess-x', messageId: 'msg-x', filename: 'bar.html' });

    // /files/content called with Bearer + path
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/files/content?path=outputs%2Ffoo%2Fbar.html');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret:nanoclaw');

    // skillExecutionNotificationsHandler called with normalized body
    expect(vi.mocked(skillExecutionNotificationsHandler)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(skillExecutionNotificationsHandler).mock.calls[0][0] as Record<string, unknown>;
    expect(call.channel).toBe('telegram');
    expect(call.chatId).toBe('telegram:5292106449');
    expect(call.threadId).toBe('tg:t-1');
    expect(call.message).toBe('こちらです');
    const files = call.files as Array<{ filename: string; contentBase64: string }>;
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('bar.html');
    expect(Buffer.from(files[0].contentBase64, 'base64').toString('utf-8')).toBe('<html>hi</html>');
  });

  // NOTE: deshi daemon の `/files/content` は `extension` を **leading dot 抜き**
  // で返す (daemon/src/routes/files.ts:446 `extension: ext.slice(1)`)。
  // 本テストはその実体に合わせて `md` 形式を使う。直前の修正で `.md` 形式と
  // 誤比較していたため md→html 差し替えが全くトリガーしないリグレッションが
  // 出ていたので、ここでフィクスチャ形式を本物に揃えて防止する。
  it('.md は renderedHtml を優先し、filename を .html に差し替えて送る', async () => {
    mockFilesContent({
      path: 'outputs/foo/notes.md',
      name: 'notes.md',
      extension: 'md',
      size: 9,
      encoding: 'utf-8',
      content: '# Title\nbody',
      renderedHtml: '<html><body><h1>Title</h1><p>body</p></body></html>',
    });

    const result = await daemonSendFileToChatHandler({
      path: 'outputs/foo/notes.md',
      channelContext,
    });

    expect(result.filename).toBe('notes.html');
    const call = vi.mocked(skillExecutionNotificationsHandler).mock.calls[0][0] as Record<string, unknown>;
    const files = call.files as Array<{ filename: string; contentBase64: string }>;
    expect(files[0].filename).toBe('notes.html');
    expect(Buffer.from(files[0].contentBase64, 'base64').toString('utf-8')).toBe(
      '<html><body><h1>Title</h1><p>body</p></body></html>',
    );
  });

  it('.md でも renderedHtml が空なら raw md にフォールバック (filename はそのまま)', async () => {
    mockFilesContent({
      path: 'outputs/foo/notes.md',
      name: 'notes.md',
      extension: 'md',
      size: 9,
      encoding: 'utf-8',
      content: '# Title\nbody',
      // renderedHtml omitted
    });

    const result = await daemonSendFileToChatHandler({
      path: 'outputs/foo/notes.md',
      channelContext,
    });

    expect(result.filename).toBe('notes.md');
    const call = vi.mocked(skillExecutionNotificationsHandler).mock.calls[0][0] as Record<string, unknown>;
    const files = call.files as Array<{ filename: string; contentBase64: string }>;
    expect(files[0].filename).toBe('notes.md');
    expect(Buffer.from(files[0].contentBase64, 'base64').toString('utf-8')).toBe('# Title\nbody');
  });

  it('.md → .html 差し替え時に req.filename override も .html 化される', async () => {
    mockFilesContent({
      path: 'outputs/foo/notes.md',
      name: 'notes.md',
      extension: 'md',
      size: 9,
      encoding: 'utf-8',
      content: '# Title',
      renderedHtml: '<html><h1>Title</h1></html>',
    });

    const result = await daemonSendFileToChatHandler({
      path: 'outputs/foo/notes.md',
      filename: '会議メモ.md',
      channelContext,
    });

    expect(result.filename).toBe('会議メモ.html');
  });

  it('extension が dot 付きで来ても (`.md`) 後方互換で md として扱う', async () => {
    mockFilesContent({
      path: 'outputs/foo/notes.md',
      name: 'notes.md',
      extension: '.md',
      size: 9,
      encoding: 'utf-8',
      content: '# T',
      renderedHtml: '<html><h1>T</h1></html>',
    });

    const result = await daemonSendFileToChatHandler({
      path: 'outputs/foo/notes.md',
      channelContext,
    });

    expect(result.filename).toBe('notes.html');
  });

  it('base64 ファイルはそのまま透過する (二重 encode しない)', async () => {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'); // fake PNG magic
    mockFilesContent({
      path: 'outputs/chart.png',
      name: 'chart.png',
      extension: '.png',
      size: 4,
      encoding: 'base64',
      content: original,
    });

    await daemonSendFileToChatHandler({ path: 'outputs/chart.png', channelContext });

    const call = vi.mocked(skillExecutionNotificationsHandler).mock.calls[0][0] as Record<string, unknown>;
    const files = call.files as Array<{ filename: string; contentBase64: string }>;
    expect(files[0].contentBase64).toBe(original);
  });

  it('text 省略時は空文字を message として送る', async () => {
    mockFilesContent({
      path: 'a.html',
      name: 'a.html',
      extension: '.html',
      size: 0,
      encoding: 'utf-8',
      content: '',
    });
    await daemonSendFileToChatHandler({ path: 'a.html', channelContext });
    const call = vi.mocked(skillExecutionNotificationsHandler).mock.calls[0][0] as Record<string, unknown>;
    expect(call.message).toBe('');
  });

  it('filename override が優先される (daemon 側の name より)', async () => {
    mockFilesContent({
      path: 'outputs/long-machine-name.html',
      name: 'long-machine-name.html',
      extension: '.html',
      size: 0,
      encoding: 'utf-8',
      content: '',
    });
    const result = await daemonSendFileToChatHandler({
      path: 'outputs/long-machine-name.html',
      filename: '朝のニュース.html',
      channelContext,
    });
    expect(result.filename).toBe('朝のニュース.html');
    const call = vi.mocked(skillExecutionNotificationsHandler).mock.calls[0][0] as Record<string, unknown>;
    expect((call.files as Array<{ filename: string }>)[0].filename).toBe('朝のニュース.html');
  });

  it('threadId なしの channelContext (Telegram DM 等) を受け付ける', async () => {
    mockFilesContent({
      path: 'a.html',
      name: 'a.html',
      extension: '.html',
      size: 0,
      encoding: 'utf-8',
      content: '',
    });
    await daemonSendFileToChatHandler({
      path: 'a.html',
      channelContext: { channel: 'telegram', platformId: 'telegram:42' },
    });
    const call = vi.mocked(skillExecutionNotificationsHandler).mock.calls[0][0] as Record<string, unknown>;
    expect(call.threadId).toBeNull();
  });

  // ── validation ──────────────────────────────────────────────────────────

  it('path 必須', async () => {
    await expect(daemonSendFileToChatHandler({ channelContext })).rejects.toThrow(/path is required/);
    await expect(daemonSendFileToChatHandler({ path: '', channelContext })).rejects.toThrow(/path is required/);
    await expect(daemonSendFileToChatHandler({ path: 123, channelContext })).rejects.toThrow(/path is required/);
  });

  it('channelContext 必須 (fabricate 防止)', async () => {
    await expect(daemonSendFileToChatHandler({ path: 'x.html' })).rejects.toThrow(/channelContext is required/);
    await expect(
      daemonSendFileToChatHandler({ path: 'x.html', channelContext: { channel: 'telegram' } }),
    ).rejects.toThrow(/channelContext\.platformId is required/);
  });

  it('text が文字列でないと throw', async () => {
    await expect(daemonSendFileToChatHandler({ path: 'x.html', text: 123, channelContext })).rejects.toThrow(
      /text must be a string/,
    );
  });

  it('filename が空文字だと throw', async () => {
    await expect(daemonSendFileToChatHandler({ path: 'x.html', filename: '', channelContext })).rejects.toThrow(
      /filename must be a non-empty string/,
    );
  });

  it('body が object でないと throw', async () => {
    await expect(daemonSendFileToChatHandler(null)).rejects.toThrow(/JSON object/);
    await expect(daemonSendFileToChatHandler('hi')).rejects.toThrow(/JSON object/);
  });

  // ── env / daemon errors ─────────────────────────────────────────────────

  it('DESHI_DAEMON_DEVICE_SECRET 未設定なら throw', async () => {
    delete process.env.DESHI_DAEMON_DEVICE_SECRET;
    await expect(daemonSendFileToChatHandler({ path: 'x.html', channelContext })).rejects.toThrow(
      /BOSWELL_DAEMON_DEVICE_SECRET \(or legacy DESHI_DAEMON_DEVICE_SECRET\) is not set/,
    );
  });

  it('daemon /files/content が非 2xx なら throw (status + body 含む)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"error":"file not found"}',
      json: async () => ({}),
    } as unknown as Response) as unknown as typeof fetch;

    await expect(daemonSendFileToChatHandler({ path: 'missing.html', channelContext })).rejects.toThrow(
      /deshi daemon \/files\/content failed: 404/,
    );
  });

  it('daemon の不正レスポンス shape は throw', async () => {
    mockFilesContent({ path: 'x.html' }); // missing name / content / encoding
    await expect(daemonSendFileToChatHandler({ path: 'x.html', channelContext })).rejects.toThrow(/unexpected body/);
  });

  it('fetch ネットワークエラーは propagate', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(daemonSendFileToChatHandler({ path: 'x.html', channelContext })).rejects.toThrow('ECONNREFUSED');
  });

  it('skill-execution-notifications handler が throw したら propagate', async () => {
    mockFilesContent({
      path: 'a.html',
      name: 'a.html',
      extension: '.html',
      size: 0,
      encoding: 'utf-8',
      content: '',
    });
    vi.mocked(skillExecutionNotificationsHandler).mockRejectedValueOnce(new Error('messaging_group not found'));
    await expect(daemonSendFileToChatHandler({ path: 'a.html', channelContext })).rejects.toThrow(
      'messaging_group not found',
    );
  });
});
