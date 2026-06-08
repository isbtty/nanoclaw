import { describe, it, expect, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isBotMentionedInGroup, parsePlatformId, platformIdForSource, splitForLineLimit } from './line.js';

const BOT_USER_ID = 'Ucae96675270f1640b7d04d5649e2f06e';
const ASSISTANT_NAME = 'Andy';

describe('isBotMentionedInGroup', () => {
  describe('LINE Platform が解析した mention.mentionees 経由の判定', () => {
    it('bot 自身の userId が mentionees に含まれる場合、mention として扱う', () => {
      const result = isBotMentionedInGroup(
        '@otk deshi よろしく',
        [{ userId: BOT_USER_ID, type: 'user' }],
        BOT_USER_ID,
        ASSISTANT_NAME,
      );
      expect(result).toBe(true);
    });

    it('全員 mention (type=all) の場合、mention として扱う', () => {
      const result = isBotMentionedInGroup('@all お知らせ', [{ type: 'all' }], BOT_USER_ID, ASSISTANT_NAME);
      expect(result).toBe(true);
    });

    it('bot 以外のメンバーだけが mention されている場合、mention として扱わない', () => {
      const result = isBotMentionedInGroup(
        '@田中さん 確認お願いします',
        [{ userId: 'Uotheruseridxxxxxxxxxxxxxxxxxxxxx', type: 'user' }],
        BOT_USER_ID,
        ASSISTANT_NAME,
      );
      expect(result).toBe(false);
    });

    it('複数の mentionee があり、その中に bot が含まれる場合、mention として扱う', () => {
      const result = isBotMentionedInGroup(
        '@田中 @otk deshi 一緒に確認',
        [
          { userId: 'Uotheruseridxxxxxxxxxxxxxxxxxxxxx', type: 'user' },
          { userId: BOT_USER_ID, type: 'user' },
        ],
        BOT_USER_ID,
        ASSISTANT_NAME,
      );
      expect(result).toBe(true);
    });

    it('mentionees が空配列の場合、mention.mentionees 経由では mention 扱いしない', () => {
      const result = isBotMentionedInGroup('普通のメッセージ', [], BOT_USER_ID, ASSISTANT_NAME);
      expect(result).toBe(false);
    });

    it('mentionees が undefined の場合、mention.mentionees 経由では mention 扱いしない', () => {
      const result = isBotMentionedInGroup('普通のメッセージ', undefined, BOT_USER_ID, ASSISTANT_NAME);
      expect(result).toBe(false);
    });

    it('botUserId が未取得 (/v2/bot/info 失敗等) の場合、userId 一致による mention 判定は機能しない', () => {
      const result = isBotMentionedInGroup(
        '@otk deshi よろしく',
        [{ userId: BOT_USER_ID, type: 'user' }],
        undefined,
        ASSISTANT_NAME,
      );
      expect(result).toBe(false);
    });

    it('botUserId が未取得でも、type=all の mentionee は引き続き mention 扱いになる', () => {
      const result = isBotMentionedInGroup('@all お知らせ', [{ type: 'all' }], undefined, ASSISTANT_NAME);
      expect(result).toBe(true);
    });
  });

  describe('表示名 regex のフォールバック', () => {
    it('text に ASSISTANT_NAME と一致する文字列が含まれている場合、mention として扱う', () => {
      const result = isBotMentionedInGroup('Andy ちょっと聞きたい', [], BOT_USER_ID, ASSISTANT_NAME);
      expect(result).toBe(true);
    });

    it('text の ASSISTANT_NAME に @ プレフィックスが付いていても mention として扱う', () => {
      const result = isBotMentionedInGroup('@Andy 確認お願い', [], BOT_USER_ID, ASSISTANT_NAME);
      expect(result).toBe(true);
    });

    it('text に ASSISTANT_NAME を含まない場合、mention として扱わない', () => {
      const result = isBotMentionedInGroup('Bob ちょっと聞きたい', [], BOT_USER_ID, ASSISTANT_NAME);
      expect(result).toBe(false);
    });

    it('text が空文字列の場合、mention として扱わない', () => {
      const result = isBotMentionedInGroup('', [], BOT_USER_ID, ASSISTANT_NAME);
      expect(result).toBe(false);
    });
  });

  describe('mention.mentionees と表示名 regex の優先関係', () => {
    it('mention.mentionees で bot が確定する場合、text に ASSISTANT_NAME が無くても mention 扱い', () => {
      const result = isBotMentionedInGroup(
        '@otk deshi これお願い', // ASSISTANT_NAME=Andy は含まれない
        [{ userId: BOT_USER_ID, type: 'user' }],
        BOT_USER_ID,
        ASSISTANT_NAME,
      );
      expect(result).toBe(true);
    });

    it('mention.mentionees に bot が居なくても、text に ASSISTANT_NAME があれば fallback で mention 扱い', () => {
      const result = isBotMentionedInGroup(
        'Andy 名前で呼ばれた',
        [{ userId: 'Uotheruseridxxxxxxxxxxxxxxxxxxxxx', type: 'user' }],
        BOT_USER_ID,
        ASSISTANT_NAME,
      );
      expect(result).toBe(true);
    });
  });
});

describe('parsePlatformId', () => {
  it('line:user 形式の場合、kind=user と id を返す', () => {
    expect(parsePlatformId('line:user:U123abc')).toEqual({ kind: 'user', id: 'U123abc' });
  });

  it('line:group 形式の場合、kind=group と id を返す', () => {
    expect(parsePlatformId('line:group:C123abc')).toEqual({ kind: 'group', id: 'C123abc' });
  });

  it('line:room 形式の場合、kind=room と id を返す', () => {
    expect(parsePlatformId('line:room:R123abc')).toEqual({ kind: 'room', id: 'R123abc' });
  });

  it('LINE 以外のプラットフォーム ID の場合、null を返す', () => {
    expect(parsePlatformId('telegram:123')).toBeNull();
  });

  it('未知の kind の場合、null を返す', () => {
    expect(parsePlatformId('line:unknown:abc')).toBeNull();
  });
});

describe('platformIdForSource', () => {
  it('DM (user source) の場合、line:user:<userId> を返す', () => {
    expect(platformIdForSource({ type: 'user', userId: 'U123' })).toBe('line:user:U123');
  });

  it('グループ (group source) の場合、line:group:<groupId> を返す', () => {
    expect(platformIdForSource({ type: 'group', groupId: 'C123' })).toBe('line:group:C123');
  });

  it('複数人トーク (room source) の場合、line:room:<roomId> を返す', () => {
    expect(platformIdForSource({ type: 'room', roomId: 'R123' })).toBe('line:room:R123');
  });

  it('必要な ID フィールドが欠落している場合、null を返す', () => {
    expect(platformIdForSource({ type: 'user' })).toBeNull();
  });
});

describe('splitForLineLimit', () => {
  it('上限以下の text の場合、そのまま 1 要素配列を返す', () => {
    expect(splitForLineLimit('短いテキスト', 100)).toEqual(['短いテキスト']);
  });

  it('上限を超える text の場合、上限ごとに分割した配列を返す', () => {
    const text = 'a'.repeat(250);
    const result = splitForLineLimit(text, 100);
    expect(result).toEqual(['a'.repeat(100), 'a'.repeat(100), 'a'.repeat(50)]);
  });

  it('空文字列の場合、空文字列 1 要素の配列を返す', () => {
    expect(splitForLineLimit('', 100)).toEqual(['']);
  });
});
