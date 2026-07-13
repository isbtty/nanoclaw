import { describe, it, expect, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from '../../log.js';
import { parseWorkspaceSuffixes, instanceNameFor } from './slack-instances.js';

// chat-sdk-bridge の instance URL-safe 検証 (createChatSdkBridge 内) と同一の regex。
// instanceNameFor の出力がこれを必ず満たすことを保証する。
const BRIDGE_URL_SAFE_RE = /^[A-Za-z0-9._-]+$/;

describe('parseWorkspaceSuffixes', () => {
  it('カンマ区切りの通常リストをサフィックス配列にする', () => {
    expect(parseWorkspaceSuffixes('ACME,CLIENT_B')).toEqual(['ACME', 'CLIENT_B']);
  });

  it('各要素の前後空白を trim する', () => {
    expect(parseWorkspaceSuffixes(' ACME , CLIENT_B ')).toEqual(['ACME', 'CLIENT_B']);
  });

  it('不正なサフィックス (小文字・記号) は log.warn して skip する', () => {
    expect(parseWorkspaceSuffixes('ACME,acme,CLIENT-B,OK1')).toEqual(['ACME', 'OK1']);
    expect(log.warn).toHaveBeenCalledWith('Invalid DESHI_SLACK_WORKSPACES suffix, skipping', { suffix: 'acme' });
    expect(log.warn).toHaveBeenCalledWith('Invalid DESHI_SLACK_WORKSPACES suffix, skipping', { suffix: 'CLIENT-B' });
  });

  it('重複するサフィックスは先勝ちで除去する', () => {
    expect(parseWorkspaceSuffixes('ACME,ACME,CLIENT_B')).toEqual(['ACME', 'CLIENT_B']);
  });

  it('空要素 (連続カンマ・末尾カンマ) は無視する', () => {
    expect(parseWorkspaceSuffixes('ACME,,CLIENT_B,')).toEqual(['ACME', 'CLIENT_B']);
  });

  it('空文字列の場合、空配列を返す', () => {
    expect(parseWorkspaceSuffixes('')).toEqual([]);
  });

  it('undefined の場合、空配列を返す', () => {
    expect(parseWorkspaceSuffixes(undefined)).toEqual([]);
  });
});

describe('instanceNameFor', () => {
  it('ACME → slack-acme', () => {
    expect(instanceNameFor('ACME')).toBe('slack-acme');
  });

  it('CLIENT_B → slack-client-b (_ を - に変換)', () => {
    expect(instanceNameFor('CLIENT_B')).toBe('slack-client-b');
  });

  it('導出した instance 名は chat-sdk bridge の URL-safe 検証を満たす', () => {
    for (const suffix of ['ACME', 'CLIENT_B', 'A_B_C', 'WS123']) {
      expect(instanceNameFor(suffix)).toMatch(BRIDGE_URL_SAFE_RE);
    }
  });
});
