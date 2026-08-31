import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBotUserId, parseArgs } from './enable-permission-split.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('初回セットアップの引数', () => {
  it('知識検索BOT の作業場と token を受け取れること', () => {
    expect(parseArgs(['--knowledge-group', 'ag-1', '--bot-token', 'xoxb-abc'])).toEqual({
      knowledgeGroup: 'ag-1',
      botToken: 'xoxb-abc',
    });
  });

  it('token を省いても受け付けること（自動招待だけができなくなる）', () => {
    expect(parseArgs(['--knowledge-group', 'ag-1'])).toEqual({ knowledgeGroup: 'ag-1' });
  });

  it('知らない指定は無視すること', () => {
    expect(parseArgs(['--unknown', 'x'])).toEqual({});
  });
});

describe('知識検索BOT の識別子の取得', () => {
  it('Slack が答えたら、その識別子を返すこと', async () => {
    stubFetch(() => ({ json: async () => ({ ok: true, user_id: 'UKNOW' }) }));

    expect(await fetchBotUserId('xoxb-abc')).toEqual('UKNOW');
  });

  it('Slack が断ったときは、識別子なしとして続行できること', async () => {
    stubFetch(() => ({ json: async () => ({ ok: false, error: 'invalid_auth' }) }));

    expect(await fetchBotUserId('xoxb-bad')).toBeNull();
  });

  it('Slack に繋がらないときも、識別子なしとして続行できること', async () => {
    stubFetch(() => {
      throw new Error('network down');
    });

    expect(await fetchBotUserId('xoxb-abc')).toBeNull();
  });
});
