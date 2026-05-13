---
name: deshi-add-host-tools
description: container 内 agent が host 側を叩くための deshi host-tools MCP bridge を agent group に追加する。`mcp__deshi__*` namespace 経由で、host 上で動く Node HTTP server (default `http://127.0.0.1:5180`) に forward される。deshi の handler (`health`、将来の `daemon_*` / `tool_*` カテゴリ) を NanoClaw の agent group に配線したい時に使う。
---

# deshi host-tools MCP bridge

このスキルは、container 内の agent が host 側 (将来的に deshi daemon を含む) のリソースを叩けるよう、MCP 経由の bridge を agent group に追加する。

```
[container] mcp__deshi__<tool>
   │
   │  stdio (deshi-mcp-stdio.ts) → HTTP POST
   ▼
host-tools-server (host) :5180
   │
   ▼
src/deshi/host-tools/<handler>.ts (handlers map)
```

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

詳細は `.deshi/docs/mcp-tool-naming.md` および `.deshi/adr/0009-mcp-tool-naming.md` 参照。

## Phase 1: 適用済みチェック

```bash
# host-tools-server, MCP stdio, plist テンプレートが揃っているか
test -f src/deshi/host-tools-server.ts \
  && test -f container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts \
  && test -f setup/launchd/com.isbtty.nanoclaw.host-tools.plist \
  && echo "Bridge files OK"
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

```bash
cd <project-root>
pnpm exec tsx src/deshi/host-tools-server.ts
```

起動メッセージが出たら別ターミナルで疎通確認:

```bash
curl -s http://127.0.0.1:5180/health | python3 -m json.tool
# 期待: { "ok": true, "version": "...", "uptime": ..., "timestamp": "...", "handlers": ["health"] }
```

### モード 2: 常駐起動 (本番運用)

macOS 起動時に自動起動し、落ちたら自動再起動する。`~/Library/LaunchAgents/` に plist を配置して `launchctl load` する。

```bash
PROJECT_ROOT="$(pwd)"
PNPM_PATH="$(command -v pnpm)"
DEST="$HOME/Library/LaunchAgents/com.isbtty.nanoclaw.host-tools.plist"

# テンプレートのプレースホルダを実値に置換して書き出す
sed -e "s#__PROJECT_ROOT__#${PROJECT_ROOT}#g" \
    -e "s#__PNPM_PATH__#${PNPM_PATH}#g" \
    setup/launchd/com.isbtty.nanoclaw.host-tools.plist > "$DEST"

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

例: チャットで agent に「ヘルスチェックして」「`mcp__deshi__health` を呼んで」「deshi host が生きてるか確認して」等と依頼すると、agent が tool を呼び、`{ ok: true, version: ..., handlers: ["health"] }` 相当の結果を返す。

curl による直接確認 (どのモードでも):

```bash
curl -s http://127.0.0.1:5180/health | python3 -m json.tool
curl -s -X POST http://127.0.0.1:5180/tools/health -d '{}' \
  -H 'Content-Type: application/json' | python3 -m json.tool
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
| プレースホルダが残っている (モード 2) | `sed` の置換が完全に通ったか、`cat ~/Library/LaunchAgents/com.isbtty.nanoclaw.host-tools.plist` で `__PROJECT_ROOT__` が残っていないか確認 |

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
