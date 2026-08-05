import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from '../env.js';
import { MISSING_SECRET_MESSAGE, resolveDaemonEnv, resolveDaemonEnvWithDotenv } from './daemon-env.js';

// readEnvFile は process.cwd() の実 `.env` を読むため、`.env` 側の値を
// テストから決定的に与えられるようモックする (既定は空 = process.env が勝つ)。
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
const readEnvFileMock = vi.mocked(readEnvFile);

const KEYS = ['BOSWELL_DAEMON_URL', 'BOSWELL_DAEMON_DEVICE_SECRET', 'DESHI_DAEMON_URL', 'DESHI_DAEMON_DEVICE_SECRET'];

describe('daemon 接続情報の解決', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    readEnvFileMock.mockClear();
    readEnvFileMock.mockReturnValue({});
    for (const key of KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  describe('resolveDaemonEnv (プロセス環境変数のみ)', () => {
    it('新しい BOSWELL_ のキーだけが設定されている場合、その値を使う', () => {
      process.env.BOSWELL_DAEMON_URL = 'http://boswell.example:9000';
      process.env.BOSWELL_DAEMON_DEVICE_SECRET = 'boswell-secret';

      expect(resolveDaemonEnv()).toEqual({ url: 'http://boswell.example:9000', secret: 'boswell-secret' });
    });

    it('リネーム前にセットアップした機のように旧 DESHI_ のキーだけが残っている場合でも、その値を使う', () => {
      process.env.DESHI_DAEMON_URL = 'http://deshi.example:9000';
      process.env.DESHI_DAEMON_DEVICE_SECRET = 'deshi-secret';

      expect(resolveDaemonEnv()).toEqual({ url: 'http://deshi.example:9000', secret: 'deshi-secret' });
    });

    it('新旧のキーが両方あり値が違う場合、新しい BOSWELL_ 側が勝つ', () => {
      process.env.BOSWELL_DAEMON_URL = 'http://boswell.example:9000';
      process.env.BOSWELL_DAEMON_DEVICE_SECRET = 'boswell-secret';
      process.env.DESHI_DAEMON_URL = 'http://deshi.example:9000';
      process.env.DESHI_DAEMON_DEVICE_SECRET = 'deshi-secret';

      expect(resolveDaemonEnv()).toEqual({ url: 'http://boswell.example:9000', secret: 'boswell-secret' });
    });

    it('どちらのキーも無い場合、URL は既定値になり secret は未解決になる', () => {
      expect(resolveDaemonEnv()).toEqual({ url: 'http://localhost:3100', secret: undefined });
    });

    it('プロセス環境変数だけを見るので、.env は読まない', () => {
      process.env.BOSWELL_DAEMON_DEVICE_SECRET = 'boswell-secret';

      resolveDaemonEnv();

      expect(readEnvFileMock).not.toHaveBeenCalled();
    });
  });

  describe('resolveDaemonEnvWithDotenv (プロセス環境変数 → .env の順)', () => {
    it('プロセス環境変数に無くても .env に BOSWELL_ のキーがあれば拾う', () => {
      readEnvFileMock.mockReturnValue({
        BOSWELL_DAEMON_URL: 'http://from-dotenv:9000',
        BOSWELL_DAEMON_DEVICE_SECRET: 'dotenv-boswell-secret',
      });

      expect(resolveDaemonEnvWithDotenv()).toEqual({
        url: 'http://from-dotenv:9000',
        secret: 'dotenv-boswell-secret',
      });
    });

    it('.env に旧 DESHI_ のキーしか無い場合でも拾う', () => {
      readEnvFileMock.mockReturnValue({ DESHI_DAEMON_DEVICE_SECRET: 'dotenv-deshi-secret' });

      expect(resolveDaemonEnvWithDotenv()).toEqual({
        url: 'http://localhost:3100',
        secret: 'dotenv-deshi-secret',
      });
    });

    it('.env の新しいキーより、プロセス環境変数の旧キーを優先する', () => {
      process.env.DESHI_DAEMON_DEVICE_SECRET = 'from-process-env';
      readEnvFileMock.mockReturnValue({ BOSWELL_DAEMON_DEVICE_SECRET: 'from-dotenv' });

      expect(resolveDaemonEnvWithDotenv().secret).toEqual('from-process-env');
    });

    it('.env 内に新旧のキーが両方ある場合、新しい BOSWELL_ 側が勝つ', () => {
      readEnvFileMock.mockReturnValue({
        BOSWELL_DAEMON_DEVICE_SECRET: 'dotenv-boswell-secret',
        DESHI_DAEMON_DEVICE_SECRET: 'dotenv-deshi-secret',
      });

      expect(resolveDaemonEnvWithDotenv().secret).toEqual('dotenv-boswell-secret');
    });

    it('新旧どちらのキーも見つからない場合、URL は既定値になり secret は未解決になる', () => {
      expect(resolveDaemonEnvWithDotenv()).toEqual({ url: 'http://localhost:3100', secret: undefined });
    });

    it('探索対象として新旧両方のキー名を .env に問い合わせる', () => {
      resolveDaemonEnvWithDotenv();

      expect(readEnvFileMock).toHaveBeenCalledWith(expect.arrayContaining(KEYS));
    });
  });

  it('secret 未設定時のエラー文言には新旧どちらのキー名も含まれる', () => {
    expect(MISSING_SECRET_MESSAGE).toMatch(/BOSWELL_DAEMON_DEVICE_SECRET/);
    expect(MISSING_SECRET_MESSAGE).toMatch(/DESHI_DAEMON_DEVICE_SECRET/);
  });
});
