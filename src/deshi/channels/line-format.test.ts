import { describe, it, expect } from 'vitest';

import { formatLine } from './line-format.js';

describe('formatLine', () => {
  it('strips ** bold markers into 【】 brackets', () => {
    expect(formatLine('本番 **2026-08-11 (火)** まで残り **29日**。')).toBe(
      '本番 【2026-08-11 (火)】 まで残り 【29日】。',
    );
  });

  it('strips heading markers while keeping the emoji marker in the text', () => {
    expect(formatLine('## ✅ 完了')).toBe('✅ 完了');
    expect(formatLine('### 見出し')).toBe('見出し');
  });

  it('converts a 2-column markdown table into stacked blocks', () => {
    const input = [
      '| タスク | 状態・メモ |',
      '|---|---|',
      '| **動画の作成** | 直近最優先。未確定 |',
      '| 保険を買うか決める | 未決 |',
    ].join('\n');
    expect(formatLine(input)).toBe(
      ['▼ 【動画の作成】', '　直近最優先。未確定', '', '▼ 保険を買うか決める', '　未決'].join('\n'),
    );
  });

  it('converts a markdown link into "text (url)"', () => {
    expect(formatLine('[会費リンク](https://pay.example.com/x)')).toBe('会費リンク (https://pay.example.com/x)');
  });

  it('strips horizontal rules', () => {
    expect(formatLine('前段落\n\n---\n\n後段落')).toBe('前段落\n\n後段落');
  });

  it('strips inline code backticks (no monospace support on LINE)', () => {
    expect(formatLine('設定は `foo.env` を参照')).toBe('設定は foo.env を参照');
  });

  it('passes fenced code blocks through untouched (fence markers stripped)', () => {
    expect(formatLine('```\nconst x = **not bold**;\n```')).toBe('const x = **not bold**;');
  });

  it('collapses runs of 3+ blank lines down to a single blank line', () => {
    expect(formatLine('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('leaves plain text without markdown untouched', () => {
    expect(formatLine('普通のメッセージです')).toBe('普通のメッセージです');
  });
});
