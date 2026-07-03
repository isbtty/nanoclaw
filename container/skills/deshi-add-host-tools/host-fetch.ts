/**
 * host-tools-server (http://host.docker.internal:5180) への転送 fetch。
 *
 * なぜリトライが必要か:
 *   Docker Desktop for Mac の `host.docker.internal` は VM 内のユーザー空間
 *   ネットワークスタック (gvisor/vpnkit) 経由で解決される。host 側インターフェースの
 *   上下 (Tailscale 再接続 / DHCP 更新 / リモート接続の抜き差し等) に伴って
 *   刹那的に ENOTFOUND / ECONNREFUSED を返すことがある。これは数百 ms で復帰する
 *   一過性の事象なので、1 回失敗しただけで諦めると、生きている host-tools-server が
 *   「接続できない」障害としてユーザーに露出してしまう (deshi の Telegram 会話が
 *   突然切れる症状)。
 *
 * 方針:
 *   - fetch が **例外を投げた** = HTTP 応答が返っていない = 接続クラスの失敗。
 *     これを指数バックオフ ([200, 500, 1000]ms) で数回リトライして吸収する。
 *   - fetch が **応答を返した** 場合 (4xx/5xx 含む) は host-tools-server まで
 *     届いているのでリトライしない (呼び出し側が status で処理する)。
 *   - AbortError (呼び出し側が signal で明示的に中断) はリトライせず即伝播する。
 *   - 全リトライ枯渇後、Linux (network=host) 向けに localhost へ 1 回だけ
 *     フォールバックする (Docker Desktop Mac では localhost = container 自身なので
 *     効かないが、害はない)。
 *
 * 副作用を持たない純モジュールとして deshi-mcp-stdio.ts から切り出してある
 * (run-start-guard.ts と同じ理由: deshi-mcp-stdio.ts は import 時に stdio server を
 * 起動する副作用があり単体テストできないため)。
 */

/** リトライ間の待機時間 (ms)。長さ + 1 が最大試行回数。 */
export const HOST_FETCH_RETRY_DELAYS_MS = [200, 500, 1000];

export interface HostFetchDeps {
  /** テスト用に fetch を差し替える。省略時は global fetch。 */
  fetchImpl?: typeof fetch;
  /** テスト用に sleep を差し替える (バックオフを即時化する)。 */
  sleep?: (ms: number) => Promise<void>;
  /** リトライ発生時の観測用ログ。省略時は無出力。 */
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * host-tools-server の `POST /tools/<toolName>` に args を JSON POST する。
 * 接続クラスの一過性失敗は指数バックオフでリトライして吸収する。
 *
 * @throws リトライを尽くしても接続できなかった場合、最後の接続エラーを投げる。
 *         AbortError の場合は即座に投げる。
 */
export async function hostFetch(
  hostUrl: string,
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
  deps: HostFetchDeps = {},
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => {});

  const url = `${hostUrl}/tools/${toolName}`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
    ...(signal ? { signal } : {}),
  };

  const maxAttempts = HOST_FETCH_RETRY_DELAYS_MS.length + 1;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await doFetch(url, init);
    } catch (err) {
      if (isAbortError(err)) throw err; // 明示的中断はリトライしない
      lastErr = err;
      if (attempt === maxAttempts - 1) break; // 最終試行 → フォールバックへ
      const delay = HOST_FETCH_RETRY_DELAYS_MS[attempt];
      log(
        `hostFetch ${toolName}: transient connect error (attempt ${attempt + 1}/${maxAttempts}), ` +
          `retrying in ${delay}ms: ${errMsg(err)}`,
      );
      await sleep(delay);
    }
  }

  // 全リトライ枯渇。Linux (network=host) 向けに localhost へ最後の 1 回だけ試す。
  if (hostUrl.includes('host.docker.internal')) {
    const fallbackUrl = url.replace('host.docker.internal', 'localhost');
    try {
      return await doFetch(fallbackUrl, init);
    } catch {
      // fallthrough — 元の接続エラーを投げる
    }
  }

  throw lastErr;
}
