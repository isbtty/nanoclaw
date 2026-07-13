import { describe, it, expect, vi } from 'vitest';

import {
  permalinkToThreadId,
  resolveSlackPermalinks,
  resolveThreadBackfill,
  type ThreadFetcher,
  type ThreadMessage,
} from './slack-permalink.js';

const msg = (userName: string, text: string): ThreadMessage => ({ text, author: { userName } });

/** A thread message with an explicit ts/id, for time-ordering tests. */
const tsMsg = (id: string, userName: string, text: string): ThreadMessage => ({
  id,
  text,
  author: { userName },
});

/** A ThreadFetcher whose fetchMessages returns a fixed thread for any id. */
function fetcherReturning(messages: ThreadMessage[]): ThreadFetcher {
  return { fetchMessages: vi.fn(async () => ({ messages })) };
}

describe('permalinkToThreadId', () => {
  it('splits a p<digits> permalink into <seconds>.<microseconds>', () => {
    expect(permalinkToThreadId('C09EVN3RU4R', '1783033388675629')).toBe('slack:C09EVN3RU4R:1783033388.675629');
  });

  it('prefers the parent thread_ts from the query over the message ts', () => {
    expect(permalinkToThreadId('C123', '1783033388675629', '?thread_ts=1783000000.111111&cid=C123')).toBe(
      'slack:C123:1783000000.111111',
    );
  });
});

describe('resolveSlackPermalinks', () => {
  it('appends the linked thread messages to the text', async () => {
    const adapter = fetcherReturning([msg('alice', 'boom: NPE'), msg('bob', 'line 42')]);
    const text = 'このエラー何？ https://dou-id.slack.com/archives/C09EVN3RU4R/p1783033388675629';

    const out = await resolveSlackPermalinks(adapter, text);

    expect(out).toContain(text);
    expect(out).toContain('── リンク先スレッド (C09EVN3RU4R) ──');
    expect(out).toContain('alice: boom: NPE');
    expect(out).toContain('bob: line 42');
    expect(adapter.fetchMessages).toHaveBeenCalledWith('slack:C09EVN3RU4R:1783033388.675629', {
      direction: 'forward',
      limit: 50,
    });
  });

  it('returns null when there are no Slack permalinks', async () => {
    const adapter = fetcherReturning([msg('alice', 'x')]);
    expect(await resolveSlackPermalinks(adapter, 'plain text, no link')).toBeNull();
    expect(adapter.fetchMessages).not.toHaveBeenCalled();
  });

  it('fetches each distinct link once (dedups repeats)', async () => {
    const adapter = fetcherReturning([msg('alice', 'x')]);
    const link = 'https://ws.slack.com/archives/C1/p1783033388675629';
    await resolveSlackPermalinks(adapter, `${link} then again ${link}`);
    expect(adapter.fetchMessages).toHaveBeenCalledTimes(1);
  });

  it('reports the error and skips a link whose fetch throws', async () => {
    const boom = new Error('thread_not_found');
    const adapter: ThreadFetcher = {
      fetchMessages: vi.fn(async () => {
        throw boom;
      }),
    };
    const onError = vi.fn();

    const out = await resolveSlackPermalinks(adapter, 'https://ws.slack.com/archives/C1/p1783033388675629', onError);

    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith('slack:C1:1783033388.675629', boom);
  });

  it('recovers text from Block Kit attachments when plain text is empty', async () => {
    // Automation/error notifications leave `text` empty and put the body in
    // attachments[].blocks[] — the exact case this resolver exists for.
    const errorMsg = {
      text: '',
      author: { userName: 'issuer-worker' },
      raw: {
        text: '',
        attachments: [
          {
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: '*差分更新中にエラー*' } },
              { type: 'section', text: { type: 'mrkdwn', text: '原因: The caller does not have permission' } },
            ],
          },
        ],
      },
    };
    const adapter = fetcherReturning([errorMsg]);

    const out = await resolveSlackPermalinks(adapter, 'https://ws.slack.com/archives/C1/p1783033388675629');

    expect(out).toContain('issuer-worker: *差分更新中にエラー*');
    expect(out).toContain('原因: The caller does not have permission');
  });

  it('recovers text from a top-level context block', async () => {
    const adapter = fetcherReturning([
      {
        text: '',
        author: { userName: 'bot' },
        raw: { blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'ctx line' }] }] },
      },
    ]);
    const out = await resolveSlackPermalinks(adapter, 'https://ws.slack.com/archives/C1/p1783033388675629');
    expect(out).toContain('bot: ctx line');
  });

  it('skips a resolved thread that has no renderable messages', async () => {
    const adapter = fetcherReturning([{ text: '  ', author: { userName: 'alice' }, raw: {} }]);
    expect(await resolveSlackPermalinks(adapter, 'https://ws.slack.com/archives/C1/p1783033388675629')).toBeNull();
  });
});

describe('resolveThreadBackfill', () => {
  const CUR = '1783906128.000000';

  it('returns only the messages before the current one', async () => {
    const adapter = fetcherReturning([
      tsMsg('1782511706.000000', 'root', 'thread root'),
      tsMsg('1782511800.000000', 'carol', 'earlier reply'),
      tsMsg(CUR, 'me', 'my mention'), // the triggering message — must be excluded
    ]);

    const out = await resolveThreadBackfill(adapter, 'slack:C1:1782511706.000000', CUR);

    expect(out).toContain('── このスレッドの先行メッセージ ──');
    expect(out).toContain('root: thread root');
    expect(out).toContain('carol: earlier reply');
    expect(out).not.toContain('my mention');
  });

  it('returns null when the mention is the thread root (nothing before it)', async () => {
    const adapter = fetcherReturning([tsMsg(CUR, 'me', 'first post in a new thread')]);
    expect(await resolveThreadBackfill(adapter, `slack:C1:${CUR}`, CUR)).toBeNull();
  });

  it('recovers Block Kit body for a prior message with empty text', async () => {
    const adapter = fetcherReturning([
      {
        id: '1782511706.000000',
        text: '',
        author: { userName: 'issuer-worker' },
        raw: { attachments: [{ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'エラー本文' } }] }] },
      },
      tsMsg(CUR, 'me', 'これ何？'),
    ]);

    const out = await resolveThreadBackfill(adapter, 'slack:C1:1782511706.000000', CUR);
    expect(out).toContain('issuer-worker: エラー本文');
  });

  it('reports the error and returns null when the fetch throws', async () => {
    const boom = new Error('thread_not_found');
    const adapter: ThreadFetcher = {
      fetchMessages: vi.fn(async () => {
        throw boom;
      }),
    };
    const onError = vi.fn();
    expect(await resolveThreadBackfill(adapter, 'slack:C1:1782511706.000000', CUR, onError)).toBeNull();
    expect(onError).toHaveBeenCalledWith('slack:C1:1782511706.000000', boom);
  });
});
