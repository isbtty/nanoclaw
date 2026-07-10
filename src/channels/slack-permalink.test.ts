import { describe, it, expect, vi } from 'vitest';

import {
  permalinkToThreadId,
  resolveSlackPermalinks,
  type ThreadFetcher,
  type ThreadMessage,
} from './slack-permalink.js';

const msg = (userName: string, text: string): ThreadMessage => ({ text, author: { userName } });

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
