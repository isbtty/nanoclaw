# MCP tool 命名規則

deshi が container 内 agent に公開する MCP tool の命名規則と、新 handler 追加時の手順をまとめる。

判断の正式記録は [ADR-0009](../adr/0009-mcp-tool-naming.md) を参照。

## MCP server 名

deshi 系 MCP server は **`deshi` 1 つだけ**。`container.json` の `mcpServers` の key として登録する。

```jsonc
{
  "mcpServers": {
    "deshi": {
      "command": "bun",
      "args": ["run", "/app/skills/deshi-add-host-tools/deshi-mcp-stdio.ts"],
      "env": { "DESHI_HOST_URL": "http://host.docker.internal:5180" }
    }
  }
}
```

agent から見える tool 名は `mcp__deshi__<tool>` の形になる。

## tool 名のカテゴリ (3 種、agent から見える名前)

| カテゴリ | prefix | 用途 | 例 |
|---|---|---|---|
| bridge 自身 | (なし) | host-tools-server の状態確認 | `health` |
| daemon 系 | `daemon_` | deshi daemon の API を叩く | `daemon_run_skill`, `daemon_poll_job` |
| tool 系 | `tool_` | host で完結する処理 | `tool_kindle_capture` (将来例) |

### カテゴリの判断フロー

```
新しい handler を足したい
  │
  ▼
deshi daemon の API を叩く？
  ├─ Yes → daemon_<name>
  └─ No
       │
       ▼
   host で完結する処理 (macOS GUI / OS / ファイルシステム等)？
       ├─ Yes → tool_<name>
       └─ No (bridge 自体のメタな処理) → prefix なし (例: health)
```

境界事例 (deshi daemon 経由で host 処理をする等) は「**直接の通信相手は何か**」で判断する:
- 直接 deshi daemon を叩くなら `daemon_*` (daemon の中で host 処理が走っても daemon 系)
- 直接 host のシステムリソースを叩くなら `tool_*`

## 2 階層命名: agent 名と HTTP path / handler key

container 内 stdio MCP server は agent 向けの tool 名と host-tools-server 側の HTTP path 名を **明示的に mapping** する。

| layer | 命名 | deshi prefix |
|---|---|---|
| agent (MCP tool) | `mcp__deshi__daemon_run_skill` | あり (Claude SDK が `mcp__<server>__` を自動付与) |
| container stdio `server.tool(name, ...)` | `daemon_run_skill` | なし (カテゴリ規約) |
| HTTP path | `POST /tools/deshi_daemon_run_skill` | **あり** (`deshi_` を明示) |
| handler key | `handlers.deshi_daemon_run_skill` | **あり** |
| handler file | `src/deshi/host-tools/deshi_daemon_run_skill.ts` | **あり** |

実装例:

```typescript
// container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts
server.tool(
  'daemon_run_skill',                                            // agent 側
  '<description>', { /* schema */ },
  async (args) => callHostTool('deshi_daemon_run_skill', args),  // HTTP 側
);
```

### `health` だけは例外

agent / HTTP path / handler key すべて `health` のまま (deshi prefix を付けない)。bridge 自身の生存確認なので deshi 系であることを再度明示する意味が薄いため。

| layer | health |
|---|---|
| agent | `mcp__deshi__health` |
| HTTP | `POST /tools/health` または `GET /health` |
| handler key | `handlers.health` |
| handler file | `src/deshi/host-tools/health.ts` |

### なぜ 2 階層にするか

- **agent 側は短くシンプルに**: `mcp__deshi__deshi_daemon_run_skill` のように `deshi` を二重に書きたくない (Claude SDK が `mcp__deshi__` を自動付与してくれるので冗長)
- **host 側は明示的に**: log や handler file 名を見たときに「これは deshi 系の処理だ」と即座にわかるようにしたい (host-tools-server が将来別の subsystem も hosting する可能性を考慮)

## 新 handler の追加手順

新 handler を `daemon_foo` カテゴリ (deshi daemon を叩く) で追加する場合の標準フロー。

### 1. handler 関数の実装

`src/deshi/host-tools/deshi_daemon_foo.ts` を新規作成 (HTTP path 側の名前 = `deshi_daemon_foo`)。

```typescript
// src/deshi/host-tools/deshi_daemon_foo.ts
export interface DaemonFooRequest {
  // body の型
}

export async function daemonFooHandler(body: unknown): Promise<unknown> {
  const req = body as DaemonFooRequest;
  // deshi daemon に HTTP リクエスト
  return { ok: true, result: '...' };
}
```

### 2. barrel に登録

`src/deshi/host-tools/index.ts` の `handlers` map にエントリを追加。

```typescript
import { daemonFooHandler } from './deshi_daemon_foo.js';

export const handlers: Record<string, HostToolHandler> = {
  // ...
  deshi_daemon_foo: daemonFooHandler,
};
```

これで `POST /tools/deshi_daemon_foo` が動く。

### 3. MCP tool の公開

`container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts` に `server.tool('daemon_foo', ...)` を追加。**agent 側の名前 (短い) と HTTP 側の名前 (`deshi_` prefix 付き) を 2 つ書く**。

```typescript
import { z } from 'zod';

server.tool(
  'daemon_foo',                                          // ← agent 側 (mcp__deshi__daemon_foo)
  '<agent 向け description>',
  {
    arg1: z.string().describe('...'),
  },
  async (args) => callHostTool('deshi_daemon_foo', args), // ← HTTP 側 (/tools/deshi_daemon_foo)
);
```

これで agent から `mcp__deshi__daemon_foo` で呼べる。

### 4. agent group の再起動

container.json は変えていないので image rebuild は不要。`ncl groups restart` で走っている container を再起動するだけ。

```bash
ncl groups restart --id "$GROUP_ID"
```

(現行の `mcpServers` 設定で新たに spawn されると、`deshi-mcp-stdio.ts` 内の新 tool が読まれる)

### 5. 動作確認

```bash
# host 側 (HTTP path は deshi_ prefix 付き)
curl -s -X POST http://127.0.0.1:5180/tools/deshi_daemon_foo \
  -H 'Content-Type: application/json' \
  -d '{"arg1": "test"}' | python3 -m json.tool

# container 内 (agent から、prefix なし)
# agent に「daemon_foo を呼んで」「mcp__deshi__daemon_foo を arg1=test で呼んで」等
```

## 物理配置まとめ

| 種類 | 場所 | mount/参照経路 |
|---|---|---|
| host 用 handler | `src/deshi/host-tools/<httpName>.ts` (`<httpName>` = `deshi_<...>` または `health`) | host の Node プロセスで実行 |
| handler barrel | `src/deshi/host-tools/index.ts` | host-tools-server が import |
| container 用 MCP stdio | `container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts` | container 内 `/app/skills/deshi-add-host-tools/` に mount |
| skill SKILL.md | `.claude/skills/deshi-add-host-tools/SKILL.md` | host 側 Claude Code が読み込み (container には行かない) |
| launchd plist テンプレート | `setup/launchd/com.isbtty.nanoclaw.host-tools.plist` | skill が `~/Library/LaunchAgents/` に展開 |

## agent から見える tool 名一覧 (現状)

| agent 名 | HTTP path | カテゴリ | 説明 |
|---|---|---|---|
| `mcp__deshi__health` | `POST /tools/health` / `GET /health` | (例外) | bridge 自身の生存確認、registered handlers 一覧 |
| `mcp__deshi__daemon_run_skill` | `POST /tools/deshi_daemon_run_skill` | daemon | deshi daemon の `POST /run` を叩いて jobId を返す。auto-auth (localhost + channelContext) |
| `mcp__deshi__daemon_poll_until_done` | `POST /tools/deshi_daemon_poll_until_done` | daemon | jobId に対する long polling。completed/failed の最終状態を 1 回のレスポンスで返す。daemonRestarted / timedOut フラグあり |

agent から `daemon_run_skill` で投げられる skill は deshi 側 `NANOCLAW_SKILL_ALLOWLIST` で 5 個 (`sync` / `ingest` / `ingest-business-cards` / `ingest-diary` / `ingest-kindle`) に絞られる。MCP の `z.enum` でも入力時点で弾く。

将来 `tool_*` カテゴリ (host 完結処理) を追加する場合は同じ 2 階層命名で:
- agent: `mcp__deshi__tool_kindle_capture`
- HTTP: `POST /tools/deshi_tool_kindle_capture`

## upstream との関係

upstream の `container/agent-runner/src/providers/claude.ts:294-297` が:

```typescript
allowedTools: [
  ...TOOL_ALLOWLIST,
  ...Object.keys(this.mcpServers).map(mcpAllowPattern),  // ← container.json から自動生成
],
```

の形で MCP allowlist を自動生成しているため、`container.json` の `mcpServers` に `"deshi"` を登録すれば `mcp__deshi__*` が自動的に allowed になる。

**`TOOL_ALLOWLIST` を直接編集する必要は無い** (ADR-0002 namespace 隔離を維持)。

## 参考

- [ADR-0009](../adr/0009-mcp-tool-naming.md) — 本ルールの正式な判断記録
- [ADR-0002](../adr/0002-deshi-namespace.md) — namespace 隔離 (deshi コードは `src/deshi/**` と `container/skills/deshi-*/`)
- skill: `.claude/skills/deshi-add-host-tools/SKILL.md`
