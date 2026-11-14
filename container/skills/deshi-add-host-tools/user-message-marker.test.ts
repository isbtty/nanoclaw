/**
 * run_start ガード marker の単体テスト。
 *
 * 回帰対象: グループチャットの @メンション無し発話 (kind='chat-sdk',
 * trigger=0) で marker が進まず、正当な追撃依頼が恒久 dedupe された事故
 * (2026-08-23 Telegram グループで再現)。marker は kind ベースで、trigger
 * 値に依存しないことを固定する。
 */
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';

import { readMaxUserMessageSeq } from './user-message-marker.js';

function makeDb(rows: Array<{ seq: number; kind: string; trigger: number }>): Database {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE messages_in (seq INTEGER UNIQUE, kind TEXT NOT NULL, trigger INTEGER NOT NULL DEFAULT 1)',
  );
  const insert = db.prepare('INSERT INTO messages_in (seq, kind, trigger) VALUES (?, ?, ?)');
  for (const r of rows) insert.run(r.seq, r.kind, r.trigger);
  return db;
}

describe('readMaxUserMessageSeq', () => {
  it('行が無ければ 0 (初回)', () => {
    expect(readMaxUserMessageSeq(makeDb([]))).toBe(0);
  });

  it('@メンション付き発話 (chat-sdk, trigger=1) で進む', () => {
    const db = makeDb([{ seq: 10, kind: 'chat-sdk', trigger: 1 }]);
    expect(readMaxUserMessageSeq(db)).toBe(10);
  });

  it('@メンション無しのグループ発話 (chat-sdk, trigger=0) でも進む — 回帰テスト', () => {
    const db = makeDb([
      { seq: 146, kind: 'chat-sdk', trigger: 1 }, // 最初の依頼 (メンション付き)
      { seq: 150, kind: 'chat-sdk', trigger: 0 }, // 追撃 (メンション無し)
    ]);
    // 旧実装 (WHERE trigger=1) は 146 を返し、seq 150 の追撃が恒久 dedupe されていた
    expect(readMaxUserMessageSeq(db)).toBe(150);
  });

  it("kind='chat' も数える", () => {
    const db = makeDb([{ seq: 5, kind: 'chat', trigger: 0 }]);
    expect(readMaxUserMessageSeq(db)).toBe(5);
  });

  it('webhook (skill 実行結果の context 注入) では進まない', () => {
    const db = makeDb([
      { seq: 146, kind: 'chat-sdk', trigger: 1 },
      { seq: 148, kind: 'webhook', trigger: 0 }, // job 完了通知
    ]);
    // 完了通知そのものが再委譲の免罪符にならないこと
    expect(readMaxUserMessageSeq(db)).toBe(146);
  });

  it('task / system (内部イベント) では進まない', () => {
    const db = makeDb([
      { seq: 20, kind: 'chat-sdk', trigger: 1 },
      { seq: 21, kind: 'task', trigger: 0 },
      { seq: 22, kind: 'system', trigger: 0 },
    ]);
    expect(readMaxUserMessageSeq(db)).toBe(20);
  });
});
