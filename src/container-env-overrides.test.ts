import { describe, expect, it } from 'vitest';

import { parseEnvOverrides } from './container-env-overrides.js';

describe('parseEnvOverrides', () => {
  const raw = JSON.stringify({
    byMessagingGroup: {
      'mg-aaa': { CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS: '1' },
      'mg-bbb': { FOO: 'bar', BAD: 42 },
    },
  });

  it('returns the entry for a listed messaging group', () => {
    expect(parseEnvOverrides(raw, 'mg-aaa')).toEqual({ CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS: '1' });
  });

  it('returns {} for an unlisted messaging group', () => {
    expect(parseEnvOverrides(raw, 'mg-zzz')).toEqual({});
  });

  it('drops non-string values', () => {
    expect(parseEnvOverrides(raw, 'mg-bbb')).toEqual({ FOO: 'bar' });
  });

  it('returns {} when byMessagingGroup is absent', () => {
    expect(parseEnvOverrides('{}', 'mg-aaa')).toEqual({});
  });

  it('throws on malformed JSON (caller warns and ignores)', () => {
    expect(() => parseEnvOverrides('{nope', 'mg-aaa')).toThrow();
  });
});
