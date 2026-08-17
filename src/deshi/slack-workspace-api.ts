/**
 * チャンネル自動セットアップで必要な Slack Web API 呼び出し (ADR-0019 §5.2)。
 *
 * chat-sdk のアダプタはチャンネル情報の取得と bot の招待を公開していないため、
 * ここだけ host から Slack Web API を直接叩く。使うのは primary instance
 * (管理者BOT) の bot token。
 *
 * **すべて best-effort。** スコープ不足・API 変更・ネットワーク断のいずれでも
 * `null` / `false` を返し、呼び出し側はセットアップを続行する。ここで throw すると
 * 「チャンネルは配線されたのにセットアップだけ落ちた」中途半端な状態になるため。
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const SLACK_API = 'https://slack.com/api';

function botToken(): string | undefined {
  return process.env.SLACK_BOT_TOKEN || readEnvFile(['SLACK_BOT_TOKEN']).SLACK_BOT_TOKEN;
}

async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const token = botToken();
  if (!token) {
    log.warn('Slack workspace API skipped — SLACK_BOT_TOKEN not set', { method });
    return null;
  }
  try {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (data.ok !== true) {
      log.warn('Slack workspace API returned not-ok', { method, error: data.error });
      return null;
    }
    return data;
    // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort: どの失敗でもセットアップは続行する
  } catch (err) {
    log.warn('Slack workspace API call failed', { method, err });
    return null;
  }
}

/**
 * チャンネルを作った人の Slack user id。取れなければ `null`。
 *
 * Slack の「チャンネル管理者」ロールは公開 Web API から一覧できないため、
 * 代わりに creator を候補として使う (ADR-0019 §5.2)。
 */
export async function fetchChannelCreator(channelId: string): Promise<string | null> {
  const data = await call('conversations.info', { channel: channelId });
  const channel = data?.channel as { creator?: unknown } | undefined;
  return typeof channel?.creator === 'string' ? channel.creator : null;
}

/**
 * bot をチャンネルに招待する。成功したら true。
 *
 * 既に参加済み (`already_in_channel`) でも `ok: false` が返るため false になるが、
 * 呼び出し側は「招待できたか」ではなく「案内文を出すか」の判断にしか使わないので
 * 区別しない。
 */
export async function inviteToChannel(channelId: string, userId: string): Promise<boolean> {
  const data = await call('conversations.invite', { channel: channelId, users: userId });
  return data !== null;
}
