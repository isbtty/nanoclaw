/**
 * Handler: deshi daemon の `POST /run` を叩いて 202 + jobId を返す。
 *
 * HTTP path : POST /tools/deshi_daemon_run_skill
 * agent tool: mcp__deshi__daemon_run_skill
 *
 * deshi daemon は `127.0.0.1` + `channelContext != null` の組み合わせで
 * auto-auth (deviceId="nanoclaw") するため、本 handler は Authorization
 * ヘッダを付けない。
 *
 * 詳細仕様: isbtty/deshi#199 工程 5 / ADR-0009。
 *
 * 中間 ack の動的化 (deshi #423 後続):
 *   202 を返した直後に fire-and-forget で `claude -p --model haiku` を spawn し、
 *   input を 15 文字程度の平易日本語に要約させて ack-cache に格納する。
 *   poll_until_done が「同 session で連投された 2 回目以降の ack」を出すときに
 *   この要約を override 文として使う。失敗しても本体には影響させない。
 */

import { spawn } from 'node:child_process';

import { putJobAck } from '../ack-cache.js';
import { log } from '../../log.js';

interface ChannelContext {
  channel: string;
  platformId: string;
  threadId?: string;
}

const HAIKU_MODEL = process.env.DESHI_RUN_ACK_HAIKU_MODEL ?? 'claude-haiku-4-5';
const HAIKU_TIMEOUT_MS = Number(process.env.DESHI_RUN_ACK_HAIKU_TIMEOUT_MS ?? 20000);
const HAIKU_INPUT_PREVIEW_CHARS = 300;
const HAIKU_OUTPUT_MAX_CHARS = 40;

function buildSummaryPrompt(input: string): string {
  const preview = input.length > HAIKU_INPUT_PREVIEW_CHARS ? input.slice(0, HAIKU_INPUT_PREVIEW_CHARS) + '…' : input;
  return [
    '次の AI 指示を、エンドユーザーに「今これをやっています」と知らせるための',
    '短い 1 行に要約してください。ルール:',
    '- 12〜18 文字以内 (日本語)',
    '- 文末は「〜してます」または「〜中」',
    '- 末尾に内容を表す絵文字を 1 つ',
    '- 専門用語 / 英語の skill 名 (/boswell-xxx 等) は使わない',
    '- 説明や前置きは出力せず、要約 1 行のみを出力',
    '',
    '指示:',
    preview,
  ].join('\n');
}

function sanitizeSummary(raw: string): string {
  // claude -p --output-format text は本文だけ返すが、改行 / 引用符 / 過剰な空白
  // を念のためトリム。長すぎる場合は切る。
  const oneLine = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(' ');
  const stripped = oneLine.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '');
  return stripped.slice(0, HAIKU_OUTPUT_MAX_CHARS);
}

/**
 * fire-and-forget。haiku を spawn して input を要約し、結果を ack-cache に
 * 書き込む。失敗 / timeout は warn ログだけ残して握り潰す。
 */
function spawnHaikuSummary(jobId: string, input: string): void {
  const prompt = buildSummaryPrompt(input);
  const child = spawn(
    'claude',
    ['-p', '--model', HAIKU_MODEL, '--effort', 'low', '--output-format', 'text', '--disable-slash-commands', prompt],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    log.warn('ack haiku timed out', { jobId, timeoutMs: HAIKU_TIMEOUT_MS });
  }, HAIKU_TIMEOUT_MS);

  child.on('error', (err) => {
    clearTimeout(timer);
    log.warn('ack haiku spawn error', { jobId, err: String(err) });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      log.warn('ack haiku exited non-zero', { jobId, code, stderr: stderr.slice(0, 200) });
      return;
    }
    const summary = sanitizeSummary(stdout);
    if (!summary) {
      log.warn('ack haiku produced empty summary', { jobId });
      return;
    }
    putJobAck(jobId, summary);
  });
}

export interface DaemonRunSkillRequest {
  /**
   * 自由文 input（ADR-0009 deshi_run_start）。ユーザー発話をそのまま、または
   * skill 名が明確なら "/deshi-<skill> <args>" を渡す。deshi 側 POST /run が
   * skill 解決 + 非同期実行する（旧 5-skill 限定 allowlist は廃止）。
   */
  input: string;
  channelContext: ChannelContext;
}

export interface DaemonRunSkillResponse {
  ok: true;
  jobId: string;
  threadId: string;
}

export async function daemonRunSkillHandler(body: unknown): Promise<DaemonRunSkillResponse> {
  const req = body as DaemonRunSkillRequest;
  if (!req || typeof req.input !== 'string' || req.input.trim() === '' || !req.channelContext) {
    throw new Error('daemonRunSkill: input and channelContext are required');
  }

  const deshiUrl = process.env.DESHI_DAEMON_URL ?? 'http://localhost:3100';

  const res = await fetch(`${deshiUrl}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: req.input,
      channelContext: req.channelContext,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`deshi daemon /run failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { jobId?: string; threadId?: string };
  if (!data.jobId || !data.threadId) {
    throw new Error(`deshi daemon /run returned unexpected body: ${JSON.stringify(data)}`);
  }

  // 動的 ack の事前要約: 結果は後段の poll_until_done が拾う (失敗時は無視)。
  // 環境変数 DESHI_RUN_ACK_DISABLE_HAIKU=1 で off にできる (テスト / 障害時用)。
  if (process.env.DESHI_RUN_ACK_DISABLE_HAIKU !== '1') {
    try {
      spawnHaikuSummary(data.jobId, req.input);
    } catch (err) {
      log.warn('ack haiku schedule failed', { jobId: data.jobId, err: String(err) });
    }
  }

  return { ok: true, jobId: data.jobId, threadId: data.threadId };
}
