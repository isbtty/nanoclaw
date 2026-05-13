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

## tool 名のカテゴリ (3 種)

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

## 新 handler の追加手順

新 handler `foo` を追加する場合の標準フロー。

### 1. handler 関数の実装

`src/deshi/host-tools/foo.ts` (もしくは `daemon_foo.ts` / `tool_foo.ts` などカテゴリに合わせた名前) を新規作成。

```typescript
// src/deshi/host-tools/foo.ts
export interface FooRequest {
  // body の型
}

export async function fooHandler(body: unknown): Promise<unknown> {
  const req = body as FooRequest;
  // ... handler 実装
  return { ok: true, result: '...' };
}
```

### 2. barrel に登録

`src/deshi/host-tools/index.ts` の `handlers` map にエントリを追加。

```typescript
import { fooHandler } from './foo.js';

export const handlers: Record<string, HostToolHandler> = {
  // ...
  foo: fooHandler,
};
```

これで `POST /tools/foo` が動く。

### 3. MCP tool の公開

`container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts` に `server.tool('foo', ...)` を追加。

```typescript
import { z } from 'zod';

server.tool(
  'foo',
  '<agent 向け description>',
  {
    arg1: z.string().describe('...'),
  },
  async (args) => callHostTool('foo', args),
);
```

これで agent から `mcp__deshi__foo` で呼べる。

### 4. agent group の再起動

container.json は変えていないので image rebuild は不要。`ncl groups restart` で走っている container を再起動するだけ。

```bash
ncl groups restart --id "$GROUP_ID"
```

(現行の `mcpServers` 設定で新たに spawn されると、`deshi-mcp-stdio.ts` 内の新 tool が読まれる)

### 5. 動作確認

```bash
# host 側 (host-tools-server を再起動)
curl -s -X POST http://127.0.0.1:5180/tools/foo \
  -H 'Content-Type: application/json' \
  -d '{"arg1": "test"}' | python3 -m json.tool

# container 内 (agent から)
# agent に「foo を呼んで」「mcp__deshi__foo を arg1=test で呼んで」等
```

## 物理配置まとめ

| 種類 | 場所 | mount/参照経路 |
|---|---|---|
| host 用 handler | `src/deshi/host-tools/<name>.ts` | host の Node プロセスで実行 |
| handler barrel | `src/deshi/host-tools/index.ts` | host-tools-server が import |
| container 用 MCP stdio | `container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts` | container 内 `/app/skills/deshi-add-host-tools/` に mount |
| skill SKILL.md | `.claude/skills/deshi-add-host-tools/SKILL.md` | host 側 Claude Code が読み込み (container には行かない) |
| launchd plist テンプレート | `setup/launchd/com.isbtty.nanoclaw.host-tools.plist` | skill が `~/Library/LaunchAgents/` に展開 |

## agent から見える tool 名一覧 (現状)

工程 3 時点:

| tool 名 | 説明 |
|---|---|
| `mcp__deshi__health` | bridge 自身の生存確認、registered handlers の一覧返却 |

工程 4 / 5 以降で:

| tool 名 (予定) | 説明 |
|---|---|
| `mcp__deshi__daemon_run_skill` | deshi daemon の `POST /run` を叩く |
| `mcp__deshi__daemon_poll_job` | deshi daemon の `GET /jobs/:id` を叩く |

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
