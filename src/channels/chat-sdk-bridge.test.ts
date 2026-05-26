import { describe, expect, it } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import {
  createChatSdkBridge,
  isMarkdownEntityParseError,
  postWithMarkdownFallback,
  splitForLimit,
} from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

describe('isMarkdownEntityParseError', () => {
  it('matches Telegram "can\'t parse entities" with byte offset', () => {
    expect(
      isMarkdownEntityParseError(
        new Error("Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 474"),
      ),
    ).toBe(true);
  });

  it('matches the "can\'t find end of the entity" variant', () => {
    expect(isMarkdownEntityParseError({ message: "Can't find end of the entity starting at byte offset 100" })).toBe(
      true,
    );
  });

  it('matches the "can\'t find end tag" variant (HTML parse_mode)', () => {
    expect(isMarkdownEntityParseError({ message: "Bad Request: can't find end tag corresponding to start tag" })).toBe(
      true,
    );
  });

  it('case-insensitive', () => {
    expect(isMarkdownEntityParseError({ message: "Can't Parse Entities at byte offset 1" })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isMarkdownEntityParseError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isMarkdownEntityParseError(new Error('Bad Request: chat not found'))).toBe(false);
    expect(isMarkdownEntityParseError(new Error('429 Too Many Requests'))).toBe(false);
  });

  it('returns false for non-Error inputs', () => {
    expect(isMarkdownEntityParseError(null)).toBe(false);
    expect(isMarkdownEntityParseError(undefined)).toBe(false);
    expect(isMarkdownEntityParseError("can't parse entities")).toBe(false);
    expect(isMarkdownEntityParseError(42)).toBe(false);
  });
});

describe('postWithMarkdownFallback', () => {
  it('posts markdown on the happy path with no retry', async () => {
    const calls: Array<{ thread: string; message: AdapterPostableMessage }> = [];
    const adapter = stubAdapter({
      postMessage: async (thread: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
        calls.push({ thread, message });
        return { id: 'm-1', threadId: thread, raw: {} };
      },
    });
    const result = await postWithMarkdownFallback(adapter, 'tg:42', '**hi**', undefined);
    expect(result?.id).toBe('m-1');
    expect(calls).toHaveLength(1);
    expect((calls[0].message as { markdown?: string }).markdown).toBe('**hi**');
  });

  it('retries as plain text on entity-parse error', async () => {
    const calls: Array<AdapterPostableMessage> = [];
    let attempt = 0;
    const adapter = stubAdapter({
      postMessage: async (_thread: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
        calls.push(message);
        attempt++;
        if (attempt === 1) {
          throw new Error(
            "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 474",
          );
        }
        return { id: `m-${attempt}`, threadId: 'tg:42', raw: {} };
      },
    });
    const result = await postWithMarkdownFallback(
      adapter,
      'tg:42',
      'see https://example.com/path_with_underscore_again/edit',
      undefined,
    );
    expect(result?.id).toBe('m-2');
    expect(calls).toHaveLength(2);
    expect((calls[0] as { markdown?: string }).markdown).toBeDefined();
    expect((calls[0] as { raw?: string }).raw).toBeUndefined();
    // Retry uses `raw` (PostableRaw), which the Telegram adapter sends
    // without parse_mode (resolveParseMode keys on `markdown`).
    expect((calls[1] as { markdown?: string }).markdown).toBeUndefined();
    expect((calls[1] as { raw?: string }).raw).toBe('see https://example.com/path_with_underscore_again/edit');
  });

  it('rethrows non-entity errors without retrying', async () => {
    let attempt = 0;
    const adapter = stubAdapter({
      postMessage: async (): Promise<RawMessage<unknown>> => {
        attempt++;
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(postWithMarkdownFallback(adapter, 'tg:42', 'hi', undefined)).rejects.toThrow(/ECONNREFUSED/);
    expect(attempt).toBe(1);
  });

  it('carries files through on both attempts (so attachments survive an entity-parse retry)', async () => {
    const calls: Array<AdapterPostableMessage> = [];
    let attempt = 0;
    const adapter = stubAdapter({
      postMessage: async (_thread: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
        calls.push(message);
        attempt++;
        if (attempt === 1) {
          throw new Error("can't parse entities");
        }
        return { id: 'm-retry', threadId: 'tg:42', raw: {} };
      },
    });
    const files = [{ data: Buffer.from('PDF'), filename: 'report.pdf' }];
    await postWithMarkdownFallback(adapter, 'tg:42', 'see `report.pdf`', files);
    expect(calls).toHaveLength(2);
    expect((calls[0] as { files?: unknown[] }).files).toEqual(files);
    expect((calls[1] as { files?: unknown[] }).files).toEqual(files);
  });
});
