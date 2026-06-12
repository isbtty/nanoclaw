/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    const botToken = env.SLACK_BOT_TOKEN;
    const bridge = createChatSdkBridge({
      adapter: slackAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      // Slack now delivers file_share events with file_access:"check_file_info"
      // and no url_private — the adapter can't build a fetchData(). Resolve the
      // bytes ourselves: files.info to get url_private, then download with the
      // bot token (requires the files:read scope).
      resolveAttachmentData: async (rawFile) => {
        const id = typeof rawFile.id === 'string' ? rawFile.id : undefined;
        let url = typeof rawFile.url_private === 'string' ? rawFile.url_private : undefined;
        let name = typeof rawFile.name === 'string' ? rawFile.name : undefined;
        let mimeType = typeof rawFile.mimetype === 'string' ? rawFile.mimetype : undefined;
        if (!url && id) {
          const info = (await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(id)}`, {
            headers: { Authorization: `Bearer ${botToken}` },
          }).then((r) => r.json())) as { ok?: boolean; file?: Record<string, unknown> };
          if (info?.ok && info.file) {
            url = typeof info.file.url_private === 'string' ? info.file.url_private : url;
            name = name ?? (typeof info.file.name === 'string' ? info.file.name : undefined);
            mimeType = mimeType ?? (typeof info.file.mimetype === 'string' ? info.file.mimetype : undefined);
          }
        }
        if (!url) return null;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
        if (!resp.ok) return null;
        const data = Buffer.from(await resp.arrayBuffer());
        return { data, name, mimeType };
      },
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
});
