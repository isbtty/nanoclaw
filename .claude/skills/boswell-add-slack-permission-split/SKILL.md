---
name: boswell-add-slack-permission-split
description: `/add-slack` のオプション — 入れた Slack BOT を「管理者BOT」とし、知識検索専用の 2 つ目の BOT を足して権限分離運用にする (ADR-0021 §5.3)。2 つ目の Slack App をマニフェストから作らせ、agent group を用意し、permission_split_config を書き込むまでを誘導する。host 1 台につき 1 回。トリガー: "権限分離", "知識検索BOTを追加", "tier A", "外部研究生", "add slack permission split" (project)
user-invocable: true
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

# `/boswell-add-slack-permission-split` — Slack BOT を権限分離構成にする

## 概要

**`/add-slack` のオプション**。`/add-slack` で入れた BOT を「管理者BOT」に据えたまま、
知識検索専用の 2 つ目の BOT を足して**権限分離運用**にする。完了すると、以後のチャンネル
登録の承認に権限分離の配線が自動で続くようになる (ADR-0021 §5.2)。

- **`/add-slack` 済みであることが前提**。単独では実行できない
- **host 1 台につき 1 回**だけ実行する。チャンネルごとの設定は不要
- **nanoclaw host 上 (Mac mini) で operator が実行**する
- 冪等。やり直しても壊れない

### 何が出来上がるか

| BOT | 誰が使うか | できること |
|---|---|---|
| 管理者BOT (既存 = `/add-slack` で入れたもの) | 管理者 | skill 実行・調査・成果物・権限管理 |
| 知識検索BOT (本スキルで追加) | 外部の人を含む全員 | 公開範囲の知識検索と回答だけ。Read only |

利用者は**メンション先で使い分ける**。だから Slack App が 2 つ必要になる
(1 App = 1 bot ユーザー。identity を 2 つ持つことはできない)。

## 前提チェック

先に確認し、満たしていなければ**何も変更せずに停止**して不足を伝える。

1. `/add-slack` 済みか — `.env` に `SLACK_BOT_TOKEN` があること
2. `src/deshi/channels/slack-instances.ts` があること (無ければ ADR-0018 が未取込)
3. 管理者BOT 側のスコープ:
   - `im:write` — 承認カードの DM 配送
   - `channels:read` — チャンネル情報 (作成者) の取得
   - `channels:manage` — public チャンネルへの知識検索BOT の招待
   - `groups:write` — **private チャンネルへの招待**。private を使うなら必須

```bash
grep -c '^SLACK_BOT_TOKEN=' .env
ls src/deshi/channels/slack-instances.ts
```

> ⚠️ `im:write` が無いと、Slack の admin が「到達不能」と判定され承認カードが
> 他プラットフォームへフォールバックする (実測済み)。ここで必ず潰しておく。

## Workflow

### 1. suffix を決める

知識検索BOT の instance 名になる。**運用開始後は改名不可** (改名 = 別インスタンス
新設扱いで、`messaging_groups` 行と Chat SDK state が orphan 化する)。

`KNOWLEDGE` を既定として提案する。`[A-Z0-9_]` のみ。

以降 `<SUFFIX>` と表記する。instance 名は `slack-knowledge` のように小文字化される。

### 2. 知識検索BOT の Slack App をマニフェストから作る (ユーザー操作)

以下のマニフェストを**そのまま提示**し、api.slack.com で貼り付けてもらう。

> 1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
> 2. ワークスペースを選ぶ (管理者BOT と同じもの)
> 3. 下の JSON を貼り付けて **Create**
> 4. **Install to Workspace** → **Bot User OAuth Token** (`xoxb-...`) をコピー
> 5. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** で
>    `connections:write` を付けてトークンを作り、`xapp-...` をコピー

```json
{
  "display_information": {
    "name": "Knowledge Search",
    "description": "公開範囲の知識を検索して答えるボット"
  },
  "features": {
    "bot_user": { "display_name": "Knowledge Search", "always_online": false },
    "app_home": { "messages_tab_enabled": false }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "chat:write",
        "channels:history",
        "groups:history",
        "channels:read",
        "groups:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["app_mention", "message.channels", "message.groups"]
    },
    "socket_mode_enabled": true,
    "org_deploy_enabled": false,
    "token_rotation_enabled": false
  }
}
```

`app_mentions:read` は `app_mention` イベントの必須スコープ。無いと manifest の検証で
弾かれて App が作れない (UI から手で作る経路は自動付与されるが、manifest 経路はされない)。

**スコープが管理者BOT より狭いのは意図的**:

- `im:*` が無い — 知識検索は**チャンネルでのみ**受け付ける (ADR-0021 §2)
- `channels:manage` が無い — チャンネルへの招待は管理者BOT 側が行う
- 書き込みは `chat:write` (回答の投稿) だけ

万一この BOT が乗っ取られても、Slack 上でできることがほぼ無い状態にしてある。

### 3. `.env` 配線と再起動

**`/boswell-manage-slack-workspaces` の Workflow 3〜4 に委譲する** (同じ機構なので
手順を重複させない)。渡すのは `<SUFFIX>` と 2 で取得した 2 つのトークン。

要点だけ再掲:

```bash
DESHI_SLACK_WORKSPACES=<SUFFIX>          # 既に値があればカンマ区切りで追記
SLACK_BOT_TOKEN_<SUFFIX>=xoxb-...
SLACK_APP_TOKEN_<SUFFIX>=xapp-...
```

再起動後、instance が上がったことをログで確認する:

```bash
grep 'Channel adapter started' logs/nanoclaw.log | tail -5
```

`instance="slack-<suffix 小文字>"` の行が出ていれば成功。出ていなければ
`Channel credentials missing, skipping` を探す (トークンの入れ間違い)。

### 4. 知識検索BOT 用の agent group を作る

全チャンネル共通で 1 つだけ作る (ADR-0021 §2)。

```bash
./bin/ncl groups create --name "Knowledge Search" --folder knowledge-search
```

出力の `id` を控える。以降 `<KNOWLEDGE_AG>` と表記する。

**ここで一度 nanoclaw を再起動する** (`/boswell-restart-nanoclaw`)。`groups create` は
`agent_groups` に 1 行入れるだけで、`container_configs` の行は起動時の backfill
(`src/backfill-container-configs.ts`) が作る。行が無いまま次のコマンドを叩くと
`No container config for group` で落ちる。

再起動後、deshi MCP server を追加して知識検索専用 profile を指定する。

```bash
./bin/ncl groups config add-mcp-server --id <KNOWLEDGE_AG> \
  --name deshi \
  --command bun \
  --args '["run","/app/skills/deshi-add-host-tools/deshi-mcp-stdio.ts"]' \
  --env '{"DESHI_HOST_URL":"http://host.docker.internal:5180","DESHI_MCP_PROFILE":"knowledge"}'
```

> `--args` / `--env` は **JSON** で渡す (handler が `JSON.parse` する)。カンマ区切りで
> 書くと parse に失敗する。

`DESHI_MCP_PROFILE=knowledge` を付けた container では、MCP stdio が `health` と
`daemon_knowledge_search` / `daemon_knowledge_read` しか登録しない。skill 実行
(`boswell_run_start`) とファイル操作の tool は生えない (ADR-0021 §4)。

設定を確認する。`mcpServers.deshi.env.DESHI_MCP_PROFILE` が `knowledge` であること。

```bash
./bin/ncl groups config get --id <KNOWLEDGE_AG>
```

知識検索BOT の振る舞いを persona の先頭に固定する。`groups create` で指定した folder に
`instructions.prepend.md` を作る。この内容は spawn のたびに `CLAUDE.md` の先頭へ inline される。

> ⚠️ group の作業ディレクトリは container の初回 spawn 時に作られる
> (`src/group-init.ts` を `container-runner` が呼ぶ)。`groups create` の直後には
> **まだ存在しない**ので、先に掘っておく。

```bash
mkdir -p groups/knowledge-search
cat > groups/knowledge-search/instructions.prepend.md <<'EOF'
# 知識検索BOT

このBOTの責務は、このチャンネルに公開された範囲の知識を検索し、簡潔に答えることだけです。

- 知識は `daemon_knowledge_search` / `daemon_knowledge_read` 経由でしか取得できません。返るのはこのチャンネルに公開された範囲だけです。範囲外は存在しないものとして扱ってください。
- 知識を問われたら「知らない」と即答せず、必ず `daemon_knowledge_search` で検索してください。抜粋で足りなければ、検索で得た `docId` を `daemon_knowledge_read` に渡して本文を読んでください。
- 結果が空または薄い場合は、言い回しを変えて再検索して構いません。それでも見つからなければ「公開範囲に該当なし」と正直に伝え、推測で埋めないでください。
- 回答には根拠となった資料名を1行添えてください。チャット向けに簡潔に書いてください。
- 資料作成・分析など、作業や成果物を求める依頼は対象外です。対応できない旨を短く伝えてください。
EOF
```

反映には container の再起動が要る。

```bash
./bin/ncl groups restart --id <KNOWLEDGE_AG>
```

### 5. 導入者を特権admin にする

チャンネル登録の承認を押せる人。ここで登録した人が、以後のセットアップの起点になる。

`/boswell-manage-nanoclaw-admins grant` に委譲する。メンバー ID の調べ方の案内も
そちらにある。

### 6. 権限分離運用を有効にする

```bash
SLACK_KNOWLEDGE_BOT_TOKEN="$(grep '^SLACK_BOT_TOKEN_<SUFFIX>=' .env | cut -d= -f2-)" \
  pnpm exec tsx src/deshi/enable-permission-split.ts \
    --knowledge-group <KNOWLEDGE_AG> \
    --knowledge-instance slack-<suffix を小文字化したもの>
```

トークンは知識検索BOT の user id を `auth.test` で引くために使う (保存するのは user id
だけで、トークンは残さない)。`--bot-token` でも渡せるが、**argv は同じ host の他ユーザーに
`ps` で見えるため環境変数を推奨**する。

引けなかった場合も続行するが、**チャンネルへの自動招待ができなくなり**、代わりに
「招待してください」と案内する動きになる。出力に `knowledge bot user id` が出ていれば
自動招待まで有効。**やり直すときにトークンを省いても、覚えている user id は消えない。**

### 7. 完了を伝える

以下をユーザーに伝えて終わる:

- **以後、チャンネルに管理者BOT を招待 → メンション → DM の承認カードを押す、だけで
  そのチャンネルの権限分離セットアップが自動で走る**。合言葉やコマンドは要らない
- 承認した人と、チャンネルを作った人が、そのチャンネルの管理者になる
- **知識検索BOT 側の登録も同時に済ませる**ので、承認カードは 1 回しか出ない。
  知識検索BOT のチャンネルは「誰でも質問できる」設定になる (知識の範囲は別途 scope で縛る)
- 管理者を増やすには、そのチャンネルで「@対象者 に権限を付与して」と伝える
- 公開する知識の範囲は、承認後に DM に届くリンクから設定する。**設定するまで
  知識検索BOT は何も答えない** (deny-by-default)

## やり直し / 無効化

`permission_split_config` は 1 行だけの設定で、再実行すると上書きされる。

権限分離運用をやめるには行を消す。既にセットアップ済みのチャンネルは
`permission_split_groups` の行が残るので、そちらも消す。

```bash
sqlite3 data/v2.db 'DELETE FROM permission_split_config;'
sqlite3 data/v2.db 'DELETE FROM permission_split_groups;'
```

⚠️ **セットアップが付与した scoped admin (`user_roles`) と、知識検索BOT の配線
(`messaging_groups` / `messaging_group_agents`) はこれでは消えない。** 権限を残したく
なければ個別に外す:

```bash
./bin/ncl roles list          # agent_group_id が入っている admin 行を確認
./bin/ncl roles revoke --user <user> --role admin --group <agent group>
```

知識検索BOT 自体を外すには、`.env` から `<SUFFIX>` の宣言とトークンを消して再起動する
(`/boswell-manage-slack-workspaces` の WS 削除フローと同じ)。

## Troubleshooting

| 症状 | 見るところ |
|---|---|
| 承認カードが Slack に来ない | 管理者BOT の `im:write` スコープ。`ensureUserDm: adapter.openDM failed` がログに出る |
| セットアップが走らない | `permission_split_config` に行があるか。DM を登録した場合は対象外 (チャンネルのみ) |
| 知識検索BOT が招待されない | `knowledge_bot_user_id` が入っているか。public なら `channels:manage`、private なら `groups:write` が管理者BOT にあるか |
| 知識検索BOT が何も答えない | 知識スコープが未設定。DM のリンクから設定する (deny-by-default なので正常な挙動) |

## 関連

- 設計: `.deshi/adr/0021-bot-permission-split.md` (§5.3 が本スキル)
- 前提の Slack 導入: `/add-slack` (本スキルはそのオプション)
- instance 機構: `.deshi/adr/0018-slack-multi-workspace.md`
- 追加 WS の配線: `/boswell-manage-slack-workspaces`
- 特権admin の管理: `/boswell-manage-nanoclaw-admins`
- 知識スコープの再設定: `/boswell-update-knowledge-scope`
