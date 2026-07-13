/**
 * deshi 固有: 追加 Slack ワークスペースの instance 登録 (ADR-0018)。
 *
 * upstream の `src/channels/slack.ts` は固定 env 名 (`SLACK_BOT_TOKEN` 等) を
 * 1 組だけ読む単一インスタンス登録。本ファイルは `.env` の宣言
 * (`DESHI_SLACK_WORKSPACES`) だけで N 個目以降の Slack ワークスペースを
 * 追加登録する。プライマリワークスペースは upstream 側の default instance
 * (`instance = 'slack'`) のまま無変更。
 *
 * ⚠️ 下の factory は `src/channels/slack.ts` の factory の **ミラー** である。
 *    permalink enrichment / resolveChannelName / fetchThreadBackfill の
 *    組み立てを同一に保つこと。upstream で `src/channels/slack.ts` に diff が
 *    入ったら、本ファイルへ反映が必要か必ず差分確認すること
 *    (`/deshi-update-from-upstream` のチェックリスト参照)。
 *
 * ミラー方針: `slack-permalink.js` / `chat-sdk-bridge.js` はコピーせず import
 * して再利用する。ミラーするのは factory 本体の約 40 行のみ。
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { createChatSdkBridge } from '../../channels/chat-sdk-bridge.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { resolveSlackPermalinks, resolveThreadBackfill, type ThreadFetcher } from '../../channels/slack-permalink.js';

/**
 * `DESHI_SLACK_WORKSPACES` の生値をサフィックス配列に正規化する。
 *
 *   - カンマ区切り → trim
 *   - `/^[A-Z0-9_]+$/` で検証 (不正なものは log.warn して skip)
 *   - 重複除去 (先勝ち)
 *   - undefined / 空文字列 → `[]`
 *
 * サフィックスは env 変数名の一部 (`SLACK_BOT_TOKEN_<SUFFIX>`) になるため、
 * 大文字英数字とアンダースコアのみを許容する。
 */
export function parseWorkspaceSuffixes(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const suffix = part.trim();
    if (!suffix) continue;
    if (!/^[A-Z0-9_]+$/.test(suffix)) {
      log.warn('Invalid DESHI_SLACK_WORKSPACES suffix, skipping', { suffix });
      continue;
    }
    if (seen.has(suffix)) continue;
    seen.add(suffix);
    out.push(suffix);
  }
  return out;
}

/**
 * サフィックスから instance 名 (= registry key) を導出する。
 *
 * 例: `ACME` → `slack-acme`, `CLIENT_B` → `slack-client-b`。
 *
 * 小文字化 + `_` → `-` 変換により、Chat SDK bridge の URL-safe 検証
 * (`[A-Za-z0-9._-]+`) を必ず満たす形になる。
 */
export function instanceNameFor(suffix: string): string {
  return 'slack-' + suffix.toLowerCase().replace(/_/g, '-');
}

// --- 登録 (import 時に同期実行。credential 読みは factory 内で遅延) ---

const suffixes = parseWorkspaceSuffixes(readEnvFile(['DESHI_SLACK_WORKSPACES']).DESHI_SLACK_WORKSPACES);

for (const suffix of suffixes) {
  const instance = instanceNameFor(suffix);
  registerChannelAdapter(instance, {
    // --- ここから factory 本体は src/channels/slack.ts のミラー ---
    factory: () => {
      const env = readEnvFile([
        `SLACK_BOT_TOKEN_${suffix}`,
        `SLACK_SIGNING_SECRET_${suffix}`,
        `SLACK_APP_TOKEN_${suffix}`,
      ]);
      const botToken = env[`SLACK_BOT_TOKEN_${suffix}`];
      // bot token が無ければ null を返す。registry が
      // "Channel credentials missing, skipping { channel: 'slack-<s>' }" を出す。
      if (!botToken) return null;
      // SLACK_APP_TOKEN_<S> (xapp-…) enables Socket Mode: events arrive over an
      // outbound WebSocket, so no public HTTPS endpoint is required. When set,
      // the signing secret is optional (Slack signs socket frames separately).
      const appToken = env[`SLACK_APP_TOKEN_${suffix}`];
      const signingSecret = env[`SLACK_SIGNING_SECRET_${suffix}`];
      const useSocketMode = Boolean(appToken);
      const slackAdapter = createSlackAdapter({
        botToken,
        signingSecret,
        appToken,
        mode: useSocketMode ? 'socket' : 'webhook',
      });
      const bridge = createChatSdkBridge({
        adapter: slackAdapter,
        concurrency: 'concurrent',
        supportsThreads: true,
        // named instance: registry key / webhook route (/webhook/<instance>) /
        // Chat SDK state namespace をワークスペースごとに分離する。
        instance,
        // Inline-resolve Slack permalinks so the linked thread's messages travel
        // with the inbound text. deshi (the delegated investigator) has no Slack
        // credentials, so a bare link would otherwise be unreadable downstream.
        enrichInboundText: (_raw, currentText) =>
          resolveSlackPermalinks(slackAdapter as unknown as ThreadFetcher, currentText, (threadId, err) =>
            log.warn('slack permalink resolve failed', { instance, threadId, err }),
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
          log.warn('slack thread backfill failed', { instance, threadId: tid, err }),
        );
      return bridge;
    },
    // --- ミラーここまで ---
  });
}
