---
name: deshi-update-knowledge-scope
description: チャンネルの知識スコープを再設定するための編集リンクをオーナーの DM に発行するチャット起点コマンド (`/update-knowledge-scope`)。owner/admin 限定、時間制限付きリンク (project)
user-invocable: false
allowed-tools: Read
---

# `deshi-update-knowledge-scope` — 知識スコープ再設定リンクの再発行

## 概要

チャンネルに公開する知識（deshi の scope）を**後から変更したい**ときに、オーナーが
そのチャンネルで `/update-knowledge-scope` と送ると、deshi の知識選択ページへの
**時間制限付き編集リンク**がオーナーの DM に届く。チャンネル接続時の onboarding
リンク（`channel-scope-link.ts`）と同じ仕組みを、オーンデマンドで再発行する。

> **operator スキルではない**（`user-invocable: false`）。Claude Code から
> `/deshi-update-knowledge-scope` で実行するものではなく、**エンドユーザー（owner）が
> チャットで送るコマンド**。本ファイルは機能のドキュメント兼カタログ登録用。

## 振る舞い

| 送信者 | 結果 |
|---|---|
| owner / admin（`hasAdminPrivilege`） | 当該チャンネルの編集リンクを mint → **オーナーの DM に配信** + チャンネルに「DM に送りました」と ack |
| それ以外 | 「この操作はオーナー（管理者）のみ実行できます。」と返信、リンクは発行しない |
| deshi 連携でないグループ | 「知識スコープ編集に対応していません」と返信 |
| DM 宛先なし / 発行失敗 | その旨を返信 |

- リンクは **10分有効・1回限り**（deshi `ScopeLinkTokens`）。
- `channelId` は messaging group の `platform_id` をそのまま使う（deshi scope store の
  キーと一致、isbtty/deshi#420）。
- 認可はチャンネル登録時に scope を設定できる owner/admin と同じ集合（`hasAdminPrivilege`）。

## 起動経路

router の `deliverToAgent`（`src/router.ts`）で、汎用 `gateCommand` の手前に
`handleKnowledgeScopeCommand`（`src/modules/permissions/knowledge-scope-command.ts`）を
挟む。コマンドとして処理した場合はコンテナ / deshi passthrough には流さず、直接
`writeOutboundDirect` で応答する。

グループでは bot がエンゲージしている必要がある（メンション等）。DM ではそのまま有効。

## 関連

- isbtty/deshi#396（知識グラウンディング） / #420（channelId 正規形）
- `src/modules/permissions/channel-scope-link.ts` — リンク発行・配信の共通処理（`maybeDeliverScopeLink`）
- `src/deshi/fetch-scope-link.ts` — deshi daemon `POST /knowledge/scope-link`
- `src/command-gate.ts` — 汎用 slash コマンドゲート（本コマンドはその手前で処理）
