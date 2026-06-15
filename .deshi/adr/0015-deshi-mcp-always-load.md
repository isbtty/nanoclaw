# ADR-0015: deshi MCP server を非 deferred (alwaysLoad) にする

- Status: accepted
- Date: 2026-06-15
- Refs: isbtty/deshi#416, isbtty/deshi#405

## Context

`@anthropic-ai/claude-agent-sdk` は tool search が有効なとき、MCP サーバの tool を
**deferred (遅延)** で扱う。すなわち turn-1 prompt には tool 定義を載せず、agent が
`ToolSearch` で都度スキーマを取得してから初めて呼べる状態にする (トークン節約のため)。

`McpStdioServerConfig.alwaysLoad?: boolean` が `false` (default) の場合、deshi の
host-tools bridge (`mcp__deshi__*`、特に委譲の唯一の窓口 `deshi_run_start`) も
deferred になる。

isbtty/deshi#416 で、約1時間継続した劣化セッションが
**「`ToolSearch` でスキーマを読むだけで `tool_use` を emit しない」ループ**に陥り、
deshi daemon に委譲が一切届かないまま「送信しました」とユーザーに返す
**サイレント障害**が発生した。コンテナ自身が「実際には invoke していない」と告白した。

deferral を切る手段は SDK には server config の `alwaysLoad` しか無い
(グローバル env は存在しない)。外部 stdio MCP サーバ (deshi shim) 自身が
`alwaysLoad` を宣言する正規手段も無い (`alwaysLoad` は consumer 側が server config
に渡すもの)。

## Decision

deshi host-tools bridge の MCP tool を **常時ロード (`alwaysLoad: true`)** にする。

注入点は consumer である `container/agent-runner/src/providers/claude.ts` の
`sdkQuery({ mcpServers })` 構築箇所 1 箇所。env `MCP_ALWAYS_LOAD_SERVERS`
(comma 区切り、default `deshi`) に列挙されたサーバ名にだけ `alwaysLoad: true` を
付与する `applyAlwaysLoad()` を通す。

```ts
const MCP_ALWAYS_LOAD_SERVERS = (process.env.MCP_ALWAYS_LOAD_SERVERS ?? 'deshi')
  .split(',').map((s) => s.trim()).filter(Boolean);
// ...
mcpServers: applyAlwaysLoad(this.mcpServers),
```

### 検討した代替案と棄却理由

- **(A) データ層注入 (DB `container_configs.mcp_servers.deshi` に `alwaysLoad:true`)**:
  Tier A コード改変ゼロにできるが、(1) `ncl groups config add-mcp-server` が
  `{command,args,env}` をフィールド単位で再構築して `alwaysLoad` を握り潰す、
  (2) host/container 双方の `McpServerConfig` 型が `alwaysLoad` を持たず
  **undeclared な runtime 素通り**に依存する、(3) spawn 時 `materializeContainerJson`
  が DB を権威に container.json を上書きするため**既存全 group に DB surgery**が要る、
  という脆さがある。**棄却**。
- **(B) deshi shim (Tier B) 側で per-tool 宣言**: 外部 stdio MCP サーバが
  `alwaysLoad` を自己宣言する正規手段が無い。**不可**。
- **(C) 採用案: consumer (claude.ts) で env 駆動注入**: Tier A 1 ファイル・additive
  数行・CLI/DB に非依存で堅牢・backfill 不要・既存 group も次 spawn で自動適用。

## Consequences

- **Tier A 改変が 1 ファイル (`claude.ts`) 発生する** (ADR-0002 の「upstream 侵襲を
  最小化」原則からの逸脱)。additive な 1 hunk + helper に局所化し、upstream merge 時の
  衝突可能性を低く保つ。汎用 (env 駆動・特定サーバ名を hardcode しない) にすることで
  upstream にも受け入れられやすい形にした。
- 副作用 (SDK 型定義の注記より): `alwaysLoad` のサーバは turn-1 prompt 構築のため
  **起動時に MCP 接続完了までブロックする (最大5s、`MCP_CONNECTION_NONBLOCKING=1` を
  上書き)**。deshi bridge は同一ホストの host-tools-server を叩くだけなので接続は速く、
  実害は小さいと判断。
- プロンプトに deshi tool 定義が常駐する分トークンが増えるが、委譲不発による
  サイレント障害を防ぐ価値が上回る。
- 反映は **container 再 spawn のみ** (`container/agent-runner/src` は RO bind-mount で
  イメージに焼かれない)。host/launchd 再起動・イメージ再ビルド不要。
- プロンプト層の二重防御として deshi 側 `.deshi/nanoclaw-delegation.md` にも
  「ToolSearch を繰り返さず即 tool_use を emit せよ」を追記済 (isbtty/deshi#422)。

## See also

- ADR-0002 (deshi namespace / upstream 侵襲最小化) — 本 ADR はその例外を 1 ファイルに限定
- ADR-0009 (MCP tool naming) — 非競合
- ADR-0012 (delegation fragment fetch) — プロンプト層防御の配信機構
- isbtty/deshi#416 一次調査コメント
