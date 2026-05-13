# ADR-0009: MCP tool の命名規則とカテゴリ分け

- Status: accepted
- Date: 2026-05-13
- Refs: isbtty/deshi#199 (工程 3)

## Context

nanoclaw container ↔ host 間で MCP bridge を構築し、その上に複数の handler を載せていく。具体的には:

- container 内 agent から `mcp__<server>__<tool>` の形で host 側機能を呼べる
- handler の種類は将来増える: bridge 自身の健全性確認、deshi daemon の API 呼び出し、host で完結するスクリプト実行 等

tool 名を体系的に管理しないと:
- 同じカテゴリの handler が散らばって発見しにくい
- 将来 handler が増えた時の命名衝突
- agent から見た failure mode の区別がつかない (deshi daemon の障害なのか、host 処理の障害なのか)

ADR-0002 制定時点では MCP は具体的な対象に入っていなかったため、本 ADR で MCP に特化したルールを補完する。

## Decision

1. **MCP server 名は単一 `deshi` に統一する**
   - `container.json` の `mcpServers` に `"deshi": { ... }` の 1 エントリだけ登録する
   - agent から見える tool 名は `mcp__deshi__<tool>` の形になる
   - 将来 deshi 系の MCP server を増やしたくなったら、その時 ADR を起こして再検討する

2. **tool 名は以下 3 カテゴリで命名する**

   | カテゴリ | prefix | 用途 | 例 |
   |---|---|---|---|
   | bridge 自身 | (なし) | host-tools-server 自体の状態確認 | `health` |
   | daemon 系 | `daemon_` | deshi daemon (`POST /run` 等) の API を叩く | `daemon_run_skill`, `daemon_poll_job` |
   | tool 系 | `tool_` | host で完結する処理 (macOS GUI 操作、ファイル fetch 等) | `tool_kindle_capture` (将来例) |

   `health` だけが prefix 無しの例外。理由: bridge 自体の生存確認は **どのカテゴリにも属さない bridge 固有の概念** であり、`bridge_health` のような prefix を付けると冗長。

3. **handler の物理配置**
   - host-tools-server に登録する handler 関数は **`src/deshi/host-tools/<name>.ts`** に配置する
   - `src/deshi/host-tools/index.ts` の `handlers` barrel に登録する
   - 例: `src/deshi/host-tools/health.ts` → `index.ts` で `handlers.health = createHealthHandler(...)` として登録

4. **container 内 MCP stdio スクリプトの物理配置**
   - MCP stdio スクリプトは **`container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts`** に配置する
   - 理由: container 起動時に `container/skills/<name>/` が `/app/skills/<name>/` に read-only mount される (`src/container-runner.ts:317-321`)。container 内で実行する Bun スクリプトはこの mount で参照する
   - これは ADR-0002 の Decision「Container Skills: `container/skills/deshi-*`」の正規ルート

5. **upstream `TOOL_ALLOWLIST` は touch しない**
   - upstream の `container/agent-runner/src/providers/claude.ts` が `Object.keys(this.mcpServers).map(mcpAllowPattern)` で allowlist を自動生成する (L294-297)
   - `container.json` の `mcpServers` に `deshi` を登録すれば `mcp__deshi__*` は自動的に allowedTools に含まれる
   - したがって `TOOL_ALLOWLIST` への侵入は不要 (ADR-0002 namespace 隔離を維持)

## Consequences

### Positive

- 拡張時の判断が予測可能 — 新 handler は 3 カテゴリのどれかに必ず属する
- agent から見て failure mode が分かりやすい — `daemon_*` の失敗は daemon 問題、`tool_*` の失敗は host 処理問題、`health` の失敗は bridge 自体の問題
- ADR-0002 を完全に守れる — upstream ファイルへの侵襲ゼロ、deshi コードは `src/deshi/**` と `container/skills/deshi-*/` に閉じる
- skill 実行時の動的コピー操作が不要 — `container/skills/` に直接置けば container から読める

### Trade-offs

- カテゴリの判断が境界事例で迷う場合がある (例: deshi daemon を経由して host 処理をするケース)。原則は「直接の通信相手が deshi daemon なら `daemon_*`」「直接の通信相手が host のシステムリソースなら `tool_*`」とする
- MCP server を複数立てたくなった時には ADR を起こして本決定を見直す必要がある

## See also

- ADR-0002 (namespace 隔離) — container 用 deshi コードを `container/skills/deshi-*/` に置くルートの根拠
- `.deshi/docs/mcp-tool-naming.md` — 詳細なルールと handler 追加手順
- `src/deshi/host-tools-server.ts` — dispatcher 実装
- `src/deshi/host-tools/health.ts` — 最初の handler (本 ADR の例として参照可能)
- `container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts` — container 内 MCP stdio
