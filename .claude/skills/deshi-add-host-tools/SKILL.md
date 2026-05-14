---
name: deshi-add-host-tools
description: container 内 agent が host 側を叩くための deshi host-tools MCP bridge を agent group に追加する。`mcp__deshi__*` namespace 経由で、host 上で動く Node HTTP server (default `http://127.0.0.1:5180`) に forward される。deshi の handler (`health`、将来の `daemon_*` / `tool_*` カテゴリ) を NanoClaw の agent group に配線したい時に使う。
---

# deshi host-tools MCP bridge

このスキルは、container 内の agent が host 側 (将来的に deshi daemon を含む) のリソースを叩けるよう、MCP 経由の bridge を agent group に追加する。

```
[channel] ─→ [host] ─→ [container]
                          ├─ agent (= Claude LLM) ─ tool 呼び出し
                          │       ↓
                          └─ deshi-mcp-stdio (MCP server)
                                  │ HTTP POST
                                  ▼
                       host-tools-server (host) :5180
                                  │
                                  ▼
                       src/deshi/host-tools/<handler>.ts
```

### 用語

- **agent**: container 内で動いている Claude (LLM 本体)。Telegram 等の channel から届いたメッセージに応答を生成する主体。tool を呼ぶ時は MCP 経由で `mcp__deshi__<tool>` のような名前を使う。
- **agent group**: その agent (Claude) にどの設定 (memory / skill / MCP server / personality) を持たせるかの設定単位。NanoClaw v2 の中心概念で `ncl groups list` で一覧できる。
- **session**: 特定 channel × thread に紐づく agent の会話セッション。container 1 個 = 1 session。

以降「agent から呼ばれる名前」と書いてあれば「container 内 Claude が tool を呼ぶ時の名前」のこと。

## アーキテクチャと命名規則

- **MCP server 名**: `deshi` (固定)。container.json の `mcpServers` の key と一致させる。upstream の agent-runner が `mcpServers` から allowlist を自動生成するため (`container/agent-runner/src/providers/claude.ts:294-297`)、`mcp__deshi__*` が自動的に allowedTools に含まれる。
- **tool 名のカテゴリ** (ADR-0009):
  - `health` — bridge 自身の生存確認 (例外、prefix なし)
  - `daemon_<name>` — deshi daemon の API を叩く
  - `tool_<name>` — host で完結する処理
- **agent 名と HTTP path の 2 階層命名**: agent から見える tool 名はカテゴリだけのシンプルな形 (`mcp__deshi__daemon_run_skill`)。一方 HTTP 側は **host-tools-server が deshi 系であることを明示** するため `deshi_` prefix を付ける (`POST /tools/deshi_daemon_run_skill`)。container 内 stdio MCP server が両者を mapping する:

  ```typescript
  server.tool(
    'daemon_run_skill',                              // ← agent から呼ばれる名前
    '<description>', { /* schema */ },
    async (args) => callHostTool('deshi_daemon_run_skill', args),  // ← HTTP path 側
  );
  ```

  `health` だけは例外で agent / HTTP 両方とも prefix なし (bridge 自身の確認なので)。
- **HTTP path** 一覧:
  - `GET /health` — curl 等で host から直接疎通確認 (handlers.health を呼ぶショートカット)
  - `POST /tools/health` — MCP 経由の疎通確認 (同じく handlers.health)
  - `POST /tools/deshi_daemon_<name>` — `daemon_<name>` カテゴリの handler 呼び出し
  - `POST /tools/deshi_tool_<name>` — `tool_<name>` カテゴリの handler 呼び出し

### 現在公開している tool

| agent tool 名 | 概要 |
|---|---|
| `mcp__deshi__health` | bridge 自身の生存確認 (version / uptime / handlers) |
| `mcp__deshi__daemon_run_skill` | deshi daemon の `POST /run` に skill 実行を投げ、jobId を受け取る (auto-auth) |
| `mcp__deshi__daemon_poll_until_done` | jobId に対する long polling。completed / failed / daemonRestarted / timedOut を 1 回のレスポンスで返す |

`daemon_run_skill` で許可される skill は deshi daemon 側の `NANOCLAW_SKILL_ALLOWLIST` で **5 個 (sync / ingest / ingest-business-cards / ingest-diary / ingest-kindle)** に絞られている。これ以外を渡しても daemon 側で failed が返る (MCP の `z.enum` でも入力時点で弾く)。

agent への使い方ガイドは `container/CLAUDE.md` の `<!-- BEGIN deshi: host-tools MCP -->` ブロックに記載。

詳細は `.deshi/docs/mcp-tool-naming.md` および `.deshi/adr/0009-mcp-tool-naming.md` 参照。

## Phase 0: 事前準備 — nanoclaw/.env に DESHI_DAEMON_DEVICE_SECRET を設定

`daemon_poll_until_done` handler が deshi daemon の `GET /jobs/:jobId` を Bearer 認証で叩くため、host-tools-server には `DESHI_DAEMON_DEVICE_SECRET` を渡す必要がある。**deshi daemon `.env` の `DAEMON_DEVICE_SECRET` と同じ値を手動コピー** して nanoclaw 側にも置く (リポジトリ境界を保つため二重管理を許容)。

```bash
# 1. deshi daemon 側の secret を確認
grep '^DAEMON_DEVICE_SECRET=' /Users/<you>/code/deshi/daemon/.env

# 2. nanoclaw/.env に追記 (実値はコピー、リポジトリにはコミットしない)
cat >> .env <<EOF
# deshi host-tools bridge (工程 5 で追加)
DESHI_DAEMON_URL=http://localhost:3100
DESHI_DAEMON_DEVICE_SECRET=<deshi daemon の同名 secret と同じ値>
EOF
```

secret rotation 時は **両方を更新** する必要がある (deshi daemon と nanoclaw)。

`POST /run` は deshi daemon 側の localhost auto-auth で通るため、`DESHI_DAEMON_DEVICE_SECRET` 未設定でも `daemon_run_skill` は動く。一方、`daemon_poll_until_done` は handler 起動時に env を check して未設定なら即エラー。

## Phase 1: 適用済みチェック

```bash
# host-tools-server, MCP stdio, plist テンプレート、daemon handler が揃っているか
test -f src/deshi/host-tools-server.ts \
  && test -f container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts \
  && test -f setup/launchd/com.isbtty.nanoclaw.host-tools.plist \
  && test -f src/deshi/host-tools/deshi_daemon_run_skill.ts \
  && test -f src/deshi/host-tools/deshi_daemon_poll_until_done.ts \
  && echo "Bridge files OK"

# nanoclaw/.env に DESHI_DAEMON_DEVICE_SECRET が設定されているか
grep -q '^DESHI_DAEMON_DEVICE_SECRET=' .env && echo ".env OK"
```

このスキルは **agent group ごとに 1 回ずつ実行** する想定。同じ group に重ねて実行しても idempotent。

## Phase 2: 対象 agent group を選択

`ncl groups list` で agent group 一覧を表示し、配線したい group の id を確認する。

```bash
ncl groups list
```

このスキルでは以降のステップで group id を参照する変数 `GROUP_ID` を使う。

## Phase 3: container.json に MCP server entry を追加

対象 group の `container.json` の `mcpServers` セクションに以下のエントリを追加する。既に他の MCP server (gmail 等) が登録されていれば **マージする** (置き換えない)。

```jsonc
{
  "mcpServers": {
    "deshi": {
      "command": "bun",
      "args": ["run", "/app/skills/deshi-add-host-tools/deshi-mcp-stdio.ts"],
      "env": {
        "DESHI_HOST_URL": "http://host.docker.internal:5180"
      }
    }
  }
}
```

スキルの中身としては `ncl groups config add-mcp-server` を使うのが推奨:

```bash
ncl groups config add-mcp-server --id "$GROUP_ID" \
  --name deshi \
  --command bun \
  --args 'run,/app/skills/deshi-add-host-tools/deshi-mcp-stdio.ts' \
  --env 'DESHI_HOST_URL=http://host.docker.internal:5180'
```

(コマンドの細部は CLI の現行仕様に合わせて調整)

## Phase 4: host-tools-server の起動方法を選ぶ

このスキルの肝。**3 つのモードから選択** する。

### モード 1: 一時起動 (動作確認・開発用)

別ターミナルで手動起動する。Ctrl+C で停止できる。launchd 登録はしない。

`tsx` は `.env` を自動 load しないため、`--env-file` で渡すか env を export してから起動する:

```bash
cd <project-root>

# 方法 A: --env-file (Node 20.6+ / tsx 4.x で動く)
pnpm exec tsx --env-file=.env src/deshi/host-tools-server.ts

# 方法 B: env を 1 行で export
set -a; source .env; set +a
pnpm exec tsx src/deshi/host-tools-server.ts
```

起動メッセージで `registered handlers: health, deshi_daemon_run_skill, deshi_daemon_poll_until_done` が出ることを確認。

別ターミナルで疎通確認:

```bash
curl -s http://127.0.0.1:5180/health | python3 -m json.tool
# 期待: { "ok": true, "version": "...", "uptime": ..., "timestamp": "...",
#        "handlers": ["health", "deshi_daemon_run_skill", "deshi_daemon_poll_until_done"] }
```

### モード 2: 常駐起動 (本番運用)

macOS 起動時に自動起動し、落ちたら自動再起動する。`~/Library/LaunchAgents/` に plist を配置して `launchctl load` する。

```bash
PROJECT_ROOT="$(pwd)"
PNPM_PATH="$(command -v pnpm)"
DESHI_DAEMON_URL="$(grep '^DESHI_DAEMON_URL=' .env | cut -d= -f2- | tr -d '"' || echo 'http://localhost:3100')"
DESHI_DAEMON_DEVICE_SECRET="$(grep '^DESHI_DAEMON_DEVICE_SECRET=' .env | cut -d= -f2- | tr -d '"')"
DEST="$HOME/Library/LaunchAgents/com.isbtty.nanoclaw.host-tools.plist"

if [ -z "$DESHI_DAEMON_DEVICE_SECRET" ]; then
  echo "ERROR: DESHI_DAEMON_DEVICE_SECRET not set in .env. See Phase 0." >&2
  exit 1
fi

# テンプレートのプレースホルダを実値に置換して書き出す
sed -e "s#__PROJECT_ROOT__#${PROJECT_ROOT}#g" \
    -e "s#__PNPM_PATH__#${PNPM_PATH}#g" \
    -e "s#__DESHI_DAEMON_URL__#${DESHI_DAEMON_URL}#g" \
    -e "s#__DESHI_DAEMON_DEVICE_SECRET__#${DESHI_DAEMON_DEVICE_SECRET}#g" \
    setup/launchd/com.isbtty.nanoclaw.host-tools.plist > "$DEST"

# 念のため secret 値をプレースホルダから外れたことを確認 (chmod 600 で他ユーザーから読めなくする)
chmod 600 "$DEST"

# ロード
launchctl load "$DEST"

# 確認 (running と表示されれば OK)
launchctl list | grep com.isbtty.nanoclaw.host-tools

# 疎通確認
curl -s http://127.0.0.1:5180/health | python3 -m json.tool
```

ログは `${PROJECT_ROOT}/logs/host-tools.log` と `${PROJECT_ROOT}/logs/host-tools.error.log` に出る。

### モード 3: あとで自分でやる

何もしない。後でモード 1 / モード 2 を選んで起動する。

## Phase 5: agent group の再起動

container.json を変更したので、走っている container を再起動して新しい `mcpServers` 設定を反映させる。

```bash
ncl groups restart --id "$GROUP_ID"
```

## Phase 6: 動作確認

配線済み agent から呼ぶ。

### health (bridge 自身の生存確認)

チャットで agent に「ヘルスチェックして」「`mcp__deshi__health` を呼んで」等と依頼すると、agent が tool を呼び、`{ ok: true, version: ..., handlers: ["health", "deshi_daemon_run_skill", "deshi_daemon_poll_until_done"] }` 相当の結果を返す。

curl による直接確認 (どのモードでも):

```bash
curl -s http://127.0.0.1:5180/health | python3 -m json.tool
```

### daemon_run_skill + daemon_poll_until_done (deshi daemon 連携)

前提: **deshi daemon (`cd ~/code/deshi/daemon && pnpm dev`) が起動中** であること。

チャットで agent に「外部データを sync して」「Slack や Granola の最新を取り込んで」と依頼すると、agent は:

1. `mcp__deshi__daemon_run_skill({ skillName: "sync", channelContext })` で submit
2. ユーザーに「sync を実行開始しました」と即時返答
3. `mcp__deshi__daemon_poll_until_done({ jobId })` で結果を待つ (host 側 long polling、最大 30 分)
4. completed/failed の最終結果を整形して channel に返す

curl による直接確認:

```bash
# 1. submit
RES=$(curl -s -X POST http://127.0.0.1:5180/tools/deshi_daemon_run_skill \
  -H 'Content-Type: application/json' \
  -d '{
    "skillName": "sync",
    "channelContext": {"channel":"test","platformId":"u","threadId":"dm","isGroup":false}
  }')
JOB_ID=$(echo "$RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")
echo "JOB_ID=$JOB_ID"

# 2. wait (long polling、最終状態が返るまで HTTP 接続は開きっぱなしになる)
curl -s -X POST http://127.0.0.1:5180/tools/deshi_daemon_poll_until_done \
  -H 'Content-Type: application/json' \
  -d "{\"jobId\":\"$JOB_ID\"}" | python3 -m json.tool
# 期待: { "status": "completed", "result": "...", "pollCount": N, ... }
```

## モード切り替え / アンインストール

### モード 1 で動作確認 → モード 2 の常駐へ

```bash
# モード 1 を Ctrl+C で停止してから上記モード 2 の手順を実行
```

### モード 2 の常駐を停止

```bash
launchctl unload ~/Library/LaunchAgents/com.isbtty.nanoclaw.host-tools.plist
rm ~/Library/LaunchAgents/com.isbtty.nanoclaw.host-tools.plist
```

### スキル全体のアンインストール

```bash
# 1. group の container.json から "deshi" MCP server entry を削除
ncl groups config remove-mcp-server --id "$GROUP_ID" --name deshi

# 2. 常駐を停止 (モード 2 を選んでいた場合)
launchctl unload ~/Library/LaunchAgents/com.isbtty.nanoclaw.host-tools.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.isbtty.nanoclaw.host-tools.plist

# 3. group を再起動
ncl groups restart --id "$GROUP_ID"
```

ソースファイル (`src/deshi/host-tools-server.ts`, `.claude/skills/deshi-add-host-tools/`, `container/skills/deshi-add-host-tools/`, `setup/launchd/com.isbtty.nanoclaw.host-tools.plist`) は repo に commit されているので削除しない。

## トラブルシュート

| 症状 | 確認 |
|---|---|
| agent が `mcp__deshi__health` を「知らない」と言う | container.json の `mcpServers.deshi` が登録されているか、`ncl groups restart` で再起動したか |
| `Failed to reach deshi host service` エラー | host-tools-server が起動しているか (`curl http://127.0.0.1:5180/health`)。モード 2 なら `launchctl list \| grep host-tools` で running 状態を確認 |
| `command not found: bun` (container 内) | `./container/build.sh` がクリーン完了したか。container 内 stdio MCP server は Bun で動く前提 |
| プレースホルダが残っている (モード 2) | `sed` の置換が完全に通ったか、`cat ~/Library/LaunchAgents/com.isbtty.nanoclaw.host-tools.plist` で `__PROJECT_ROOT__` 等が残っていないか確認 |
| `DESHI_DAEMON_DEVICE_SECRET is not set on host-tools-server` | Phase 0 の .env 設定を忘れている。`grep DESHI_DAEMON .env` で確認 |
| `daemon_run_skill` が 500 を返す | (1) deshi daemon が起動しているか (`curl http://localhost:3100/run -X POST -d '{}'` が応答するか) (2) `DESHI_DAEMON_URL` が正しいか |
| `daemon_poll_until_done` の結果が `daemonRestarted: true` | deshi daemon が job の途中で再起動した。再実行が必要 |
| `daemon_poll_until_done` の結果が `timedOut: true` | skill 実行が 30 分以上かかった。`GET /jobs/<jobId>` で後追い可能 |

## セキュリティ上の注意

- host-tools-server は `127.0.0.1` でのみ listen するため、外部から到達できない
- container からは `host.docker.internal` 経由でのみ到達可能 (docker network 設定による)
- handler の応答は出力結果のみ返し、credentials 等の機密情報は返さない
- リクエストごとに timestamp + path を stderr (logs/host-tools.error.log) に記録する

## 関連

- ADR-0002 (namespace 隔離) — upstream ファイルへの侵襲ゼロを実現
- ADR-0009 (MCP tool 命名規則とカテゴリ分け)
- `.deshi/docs/mcp-tool-naming.md` (handler 追加時の参照)
- 設計の動機: isbtty/deshi#178, isbtty/deshi#189, isbtty/deshi#199
- skill パターンのベース: `.claude/skills/add-atomic-chat-tool/`
