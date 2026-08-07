/**
 * boswell#712 — 承認通知の共有チャンネル配線を保持する deshi 所有テーブル。
 *
 * ## なぜ upstream の migration registry を使わないか
 *
 * `src/db/migrations/` は upstream 管理ディレクトリで、ここに deshi 用 migration を
 * 足すと `/boswell-update-from-upstream` の恒常的な衝突点になる（ADR-0002 違反）。
 * よって deshi 所有テーブルは `CREATE TABLE IF NOT EXISTS` を読み書きの各入口で
 * 呼ぶ方式で作る。テーブル名は `deshi_` prefix を必須とする（ADR-0019）。
 *
 * FK 制約は張らない（migration 外で作るため、参照先の生存は読み出し時に検証する）。
 */
import { getDb } from '../../db/connection.js';

export interface ApprovalsChannelRow {
  channel_type: string;
  messaging_group_id: string;
  created_at: string;
  updated_at: string;
}

/** 冪等。読み書きの各エントリポイント冒頭で呼ぶ（IF NOT EXISTS なのでコストは無視できる）。 */
export function ensureSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS deshi_approvals_channel (
      channel_type       TEXT PRIMARY KEY,
      messaging_group_id TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    )
  `);
}

export function getApprovalsChannel(channelType: string): ApprovalsChannelRow | undefined {
  ensureSchema();
  return getDb().prepare('SELECT * FROM deshi_approvals_channel WHERE channel_type = ?').get(channelType) as
    | ApprovalsChannelRow
    | undefined;
}

export function setApprovalsChannel(channelType: string, messagingGroupId: string): void {
  ensureSchema();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO deshi_approvals_channel (channel_type, messaging_group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_type) DO UPDATE SET
         messaging_group_id = excluded.messaging_group_id,
         updated_at = excluded.updated_at`,
    )
    .run(channelType, messagingGroupId, now, now);
}

export function clearApprovalsChannel(channelType: string): void {
  ensureSchema();
  getDb().prepare('DELETE FROM deshi_approvals_channel WHERE channel_type = ?').run(channelType);
}
