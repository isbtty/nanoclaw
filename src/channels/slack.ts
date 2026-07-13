/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Socket Mode opt-in: set SLACK_APP_TOKEN (xapp-…) to receive events over an
 * outbound WebSocket instead of an inbound HTTPS webhook.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { resolveSlackPermalinks, resolveThreadBackfill, type ThreadFetcher } from './slack-permalink.js';

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN']);
    if (!env.SLACK_BOT_TOKEN) return null;
    // SLACK_APP_TOKEN (xapp-…) enables Socket Mode: events arrive over an
    // outbound WebSocket, so no public HTTPS endpoint is required. When set,
    // the signing secret is optional (Slack signs socket frames separately).
    const useSocketMode = Boolean(env.SLACK_APP_TOKEN);
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
      appToken: env.SLACK_APP_TOKEN,
      mode: useSocketMode ? 'socket' : 'webhook',
    });
    const bridge = createChatSdkBridge({
      adapter: slackAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      // Inline-resolve Slack permalinks so the linked thread's messages travel
      // with the inbound text. deshi (the delegated investigator) has no Slack
      // credentials, so a bare link would otherwise be unreadable downstream.
      enrichInboundText: (_raw, currentText) =>
        resolveSlackPermalinks(slackAdapter as unknown as ThreadFetcher, currentText, (threadId, err) =>
          log.warn('slack permalink resolve failed', { threadId, err }),
        ),
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    // Catch up on a thread the bot was just pulled into: when the router creates
    // a fresh per-thread session mid-thread, backfill the earlier posts so the
    // container (which never saw them) has the context. See fetchThreadBackfill
    // on the ChannelAdapter interface.
    bridge.fetchThreadBackfill = (threadId: string, currentMessageId: string) =>
      resolveThreadBackfill(slackAdapter as unknown as ThreadFetcher, threadId, currentMessageId, (tid, err) =>
        log.warn('slack thread backfill failed', { threadId: tid, err }),
      );
    return bridge;
  },
});
