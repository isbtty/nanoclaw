---
name: deshi-add-slack-workspace
description: 追加の Slack ワークスペースを nanoclaw に接続する運用スキル (ADR-0018)。DESHI_SLACK_WORKSPACES への suffix 宣言 → Slack App 作成 → .env 配線 → 再起動 → ncl 配線までを誘導する。削除手順も含む。トリガー: "ワークスペース追加", "add slack workspace", "2つ目のSlack", "クライアントのSlackにも入れたい" (project)
user-invocable: true
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

# `/deshi-add-slack-workspace` — 追加 Slack ワークスペースの接続

## 概要

プライマリ WS(upstream `slack.ts` のデフォルト instance)はそのまま、**2 つ目以降の
Slack ワークスペース**を named instance として nanoclaw に接続する。実装は
`src/deshi/channels/slack-instances.ts`(ADR-0018)で、operator がやることは
「Slack App 作成 + `.env` 宣言 + 再起動 + 配線」だけ。

- **nanoclaw host 上(Mac mini)で operator が実行**する。
- upstream 管理の `/add-slack`(初回インストール用)とは別物。本スキルは
  Slack が既にインストール済みで、**WS を増やす**ときに使う。

## 前提チェック

1. 実装が入っているか: `src/deshi/channels/slack-instances.ts` が存在すること
   (無ければ isbtty/nanoclaw#72 が未マージ。先に取り込む)。
2. プライマリ Slack が稼働中であること(`.env` に `SLACK_BOT_TOKEN` がある)。

## Workflow — WS 追加

### 1. suffix を決める(⚠️ 最重要の不可逆ポイント)

ユーザーに suffix 案を確認する。制約:

- **大文字英数字と `_` のみ**(`/^[A-Z0-9_]+$/`)。例: `ACME`, `CLIENT_B`
- instance 名は `slack-<小文字化・_→->` になる(`CLIENT_B` → `slack-client-b`)

> ⚠️ **suffix は改名不可の永続識別子**。instance 名 = registry key = webhook route =
> Chat SDK state namespace = `messaging_groups.instance` を決める。運用開始後に
> 改名すると既存チャンネルの配線・state が全部 orphan 化する(ADR-0018 制約 #5)。
> 社名変更でも変えられない前提で、汎用的すぎず具体的すぎない名前を選ばせる。

### 2. 対象 WS に Slack App を作成(ユーザー操作)

以下を案内する:

> 📋 **Slack App の作成**(追加したいワークスペース側で)
> 1. https://api.slack.com/apps → **Create New App** → 対象 WS を選択
> 2. **Socket Mode** を有効化 → App-Level Token 生成(scope: `connections:write`)→ `xapp-...` を控える
> 3. **OAuth & Permissions** → Bot Token Scopes をプライマリ App と同じに設定
>    (プライマリ App の設定画面からコピーが確実)
> 4. **Event Subscriptions** → Subscribe to bot events もプライマリと同じに
> 5. **Install to Workspace** → `xoxb-...` (Bot User OAuth Token) を控える

Socket Mode なら公開エンドポイント・Signing Secret 不要。webhook モードを使う場合のみ
`SLACK_SIGNING_SECRET_<SUFFIX>` が必要で、Event Subscriptions の URL は
`/webhook/slack-<suffix小文字>` に向ける。

### 3. `.env` に配線

`DESHI_SLACK_WORKSPACES` が既にあればカンマ区切りで suffix を追記、無ければ新規行。
token は suffix 付きで追加する:

```bash
DESHI_SLACK_WORKSPACES=ACME          # 既存があれば ...=既存,ACME
SLACK_BOT_TOKEN_ACME=xoxb-...
SLACK_APP_TOKEN_ACME=xapp-...
```

### 4. host 再起動と起動確認

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

`logs/nanoclaw.log` で確認:

| ログ | 意味 |
|---|---|
| `Channel adapter started { channel: 'slack-acme', type: 'slack', instance: 'slack-acme' }` | 起動成功 |
| `Channel credentials missing, skipping { channel: 'slack-acme' }` | token 未設定 or 変数名の suffix 不一致 |
| `Invalid DESHI_SLACK_WORKSPACES suffix, skipping` | suffix が `/^[A-Z0-9_]+$/` 違反 |

### 5. bot 招待 → messaging_group 自動作成

新 WS 側で bot をチャンネルに `/invite`(または DM 送信)してもらう。初回 inbound で
`messaging_groups` に `instance = 'slack-acme'` の行が自動作成される:

```bash
ncl messaging-groups list   # instance 列で新 WS の行を確認
```

### 6. agent group へ配線

```bash
ncl wirings create --messaging-group-id <id> --agent-group-id <id>
```

対話的にやるなら `/manage-channels` でも可(既存 WS と同じフロー)。

### 7. 運用上の注意をユーザーに伝える

1. **新 WS 側の admin/承認者には最初に bot へ 1 通 DM してもらう** — cold DM の
   フォールバックはプライマリ WS 固定なので、DM 実績が無いと承認通知が届かない
   (warm path は `user_dms` 経由で正しい instance から届く)。
2. **role は全 WS 横断で効く** — `slack:<U-id>` は instance 非依存。クライアント WS の
   ユーザーへの `ncl roles grant` は自社 WS 側でも権限を持つことを意味する。

## Workflow — WS 削除

1. `.env` の `DESHI_SLACK_WORKSPACES` から suffix を外し、`SLACK_*_<SUFFIX>` 行を削除。
2. host 再起動。以後その instance は起動しない(残った messaging_groups 行への配信は
   offline-adapter 扱いで warn ログになる)。
3. 綺麗にするなら該当 wiring / messaging_groups も削除:
   ```bash
   ncl wirings list            # 該当 wiring を特定して delete
   ncl messaging-groups list   # instance 列で特定して delete
   ```
4. Slack 側でも App をアンインストール(token 失効)しておく。

## Troubleshooting

| 症状 | 原因と対処 |
|---|---|
| 新 WS の bot が無反応 | ログに `Channel adapter started ... slack-<s>` があるか。無ければ suffix/token 名の不一致 |
| 返信が別 WS から出る | 起こらない設計(`getChannelAdapterExact` 厳密一致)。起きたら messaging_groups の instance 列を確認 |
| 新 WS だけ permalink 展開やスレッド追従が劣化 | factory ミラーのドリフトを疑う — `src/channels/slack.ts` と `src/deshi/channels/slack-instances.ts` を差分比較(ADR-0018 制約 #4) |
| 承認 DM が新 WS の admin に届かない | その admin が bot に一度も DM していない。1 通 DM してもらう |

## 関連

- 設計: `.deshi/adr/0018-slack-multi-workspace.md` / isbtty/deshi#560 / isbtty/nanoclaw#72
- 実装: `src/deshi/channels/slack-instances.ts`(upstream `slack.ts` のミラー)
- upstream 取込時のドリフト確認: `/deshi-update-from-upstream` のチェックリスト
