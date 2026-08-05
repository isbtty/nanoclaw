import { readEnvFile } from '../env.js';

/**
 * boswell daemon への接続情報 (URL / device secret) の解決を 1 か所に閉じる。
 *
 * ADR-0036 の deshi → boswell リネームで boswell 側 (`/setup-boswell` skill) は
 * `BOSWELL_DAEMON_*` を `.env` / launchd plist に書くようになったが、リネーム前に
 * セットアップした機には旧 `DESHI_DAEMON_*` が残る。両方を受け付ける必要がある
 * (isbtty/boswell#699)。
 *
 * 優先順位を各呼び出し元に散らすと、書き漏らした 1 箇所だけが古い名前でしか
 * 動かないという気づきにくい壊れ方をするため、ここを唯一の読み口とする。
 *
 * 優先順位は source が外側、key 名が内側:
 *   process.env の BOSWELL_ → process.env の DESHI_ → `.env` の BOSWELL_ → `.env` の DESHI_
 */

const DEFAULT_DAEMON_URL = 'http://localhost:3100';

const URL_KEYS = ['BOSWELL_DAEMON_URL', 'DESHI_DAEMON_URL'];
const SECRET_KEYS = ['BOSWELL_DAEMON_DEVICE_SECRET', 'DESHI_DAEMON_DEVICE_SECRET'];

/** secret 未設定時のエラー文言。両方のキー名を出して利用者が迷わないようにする。 */
export const MISSING_SECRET_MESSAGE = 'BOSWELL_DAEMON_DEVICE_SECRET (or legacy DESHI_DAEMON_DEVICE_SECRET) is not set';

export interface DaemonEnv {
  url: string;
  secret?: string;
}

function fromProcessEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

/** `process.env` だけを見る。plist / shell で env が入る前提の呼び出し元用。 */
export function resolveDaemonEnv(): DaemonEnv {
  return {
    url: fromProcessEnv(URL_KEYS) ?? DEFAULT_DAEMON_URL,
    secret: fromProcessEnv(SECRET_KEYS),
  };
}

/**
 * `process.env` → `.env` の順に見る。launchd-spawned host プロセスは interactive
 * shell env を継承せず、生成される plist にも PATH/HOME しか入らないため、
 * secret が `.env` にしか存在しないことがある。
 */
export function resolveDaemonEnvWithDotenv(): DaemonEnv {
  const fromFile = readEnvFile([...URL_KEYS, ...SECRET_KEYS]);
  const pick = (keys: string[]): string | undefined =>
    fromProcessEnv(keys) ?? keys.map((key) => fromFile[key]).find((value) => Boolean(value));
  return {
    url: pick(URL_KEYS) ?? DEFAULT_DAEMON_URL,
    secret: pick(SECRET_KEYS),
  };
}
