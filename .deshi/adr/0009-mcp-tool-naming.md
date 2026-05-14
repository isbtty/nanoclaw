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

2. **tool 名は以下 3 カテゴリで命名する** (agent から見える tool 名)

   | カテゴリ | prefix | 用途 | 例 |
   |---|---|---|---|
   | bridge 自身 | (なし) | host-tools-server 自体の状態確認 | `health` |
   | daemon 系 | `daemon_` | deshi daemon (`POST /run` 等) の API を叩く | `daemon_run_skill`, `daemon_poll_job` |
   | tool 系 | `tool_` | host で完結する処理 (macOS GUI 操作、ファイル fetch 等) | `tool_kindle_capture` (将来例) |

   `health` だけが prefix 無しの例外。理由: bridge 自体の生存確認は **どのカテゴリにも属さない bridge 固有の概念** であり、`bridge_health` のような prefix を付けると冗長。

3. **agent 名と HTTP path / handler key は 2 階層で別命名にする**

   container 内 stdio MCP server は agent 向けの tool 名と host-tools-server 側の HTTP path 名を **明示的に mapping** する:

   | layer | 命名 | deshi prefix |
   |---|---|---|
   | agent (MCP tool) | `mcp__deshi__daemon_run_skill` | あり (Claude SDK が `mcp__<server>__` を自動付与) |
   | container stdio `server.tool(name, ...)` | `daemon_run_skill` | なし (上記 (2) のカテゴリ規約) |
   | HTTP path | `POST /tools/deshi_daemon_run_skill` | **あり** (`deshi_` を明示) |
   | handler key | `handlers.deshi_daemon_run_skill` | **あり** |
   | handler file | `src/deshi/host-tools/deshi_daemon_run_skill.ts` | **あり** |

   実装例:

   ```typescript
   // container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts
   server.tool(
     'daemon_run_skill',                                       // agent 側
     '<description>', { /* schema */ },
     async (args) => callHostTool('deshi_daemon_run_skill', args), // HTTP 側
   );
   ```

   `health` だけは例外で agent / HTTP path / handler key すべて `health` のまま (bridge 自身の確認なので、deshi prefix を付ける意味が薄い)。

   **なぜこの 2 階層にするか**:
   - agent から見える MCP tool 名は短くシンプルに保ちたい (`mcp__deshi__deshi_daemon_run_skill` のように deshi が二重になるのを避ける)
   - 一方で HTTP path / handler / file を見たときに「これは deshi 系の処理だ」と即座にわかるようにしたい (host 側 code を読む人 / ログを見る人視点)
   - 両者を分離することで両方の要件を満たす

4. **handler の物理配置**
   - host-tools-server に登録する handler 関数は **`src/deshi/host-tools/<httpName>.ts`** に配置する (`<httpName>` は HTTP path 側の名前 = handler key と一致)
   - `src/deshi/host-tools/index.ts` の `handlers` barrel に登録する
   - 例: `src/deshi/host-tools/health.ts` → `handlers.health`
   - 例: `src/deshi/host-tools/deshi_daemon_run_skill.ts` → `handlers.deshi_daemon_run_skill`

5. **container 内 MCP stdio スクリプトの物理配置**
   - MCP stdio スクリプトは **`container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts`** に配置する
   - 理由: container 起動時に `container/skills/<name>/` が `/app/skills/<name>/` に read-only mount される (`src/container-runner.ts:317-321`)。container 内で実行する Bun スクリプトはこの mount で参照する
   - これは ADR-0002 の Decision「Container Skills: `container/skills/deshi-*`」の正規ルート

6. **upstream `TOOL_ALLOWLIST` は touch しない**
   - upstream の `container/agent-runner/src/providers/claude.ts` が `Object.keys(this.mcpServers).map(mcpAllowPattern)` で allowlist を自動生成する (L294-297)
   - `container.json` の `mcpServers` に `deshi` を登録すれば `mcp__deshi__*` は自動的に allowedTools に含まれる
   - したがって `TOOL_ALLOWLIST` への侵入は不要 (ADR-0002 namespace 隔離を維持)

7. **`container/CLAUDE.md` への限定的な追記を ADR-0002 の例外として許容する**
   - 工程 5 で導入する `mcp__deshi__daemon_*` の使い方ガイド (どの skill が呼べるか、2 step 実行パターン、結果分岐) は **agent が必ず読むべき技術ドキュメント** であり、`container/CLAUDE.md` に書く以外に自動 include される配置がない (container/skills/<name>/CLAUDE.md は agent-runner が自動読込しない、`groups/*/CLAUDE.local.md` は `.gitignore` 済みで顧客間共有不可)
   - そのため `container/CLAUDE.md` の末尾に **`<!-- BEGIN deshi: host-tools MCP -->` 〜 `<!-- END deshi: host-tools MCP -->`** で囲まれたブロックを追記することを例外として許容する
   - 追記内容は **public でも問題ない技術ガイドに限定** する (顧客固有情報・persona / floor 設定・機密 はここに書かない。それらは将来 jibot さんの Q4 提案する private 設定 repo + Docker volume mount で別途注入する設計に乗せる: isbtty/deshi#189 #issuecomment-4418940383)
   - 衝突対策: `/deshi-update-from-upstream` 実行時に upstream 側でこのファイルが変更されても、deshi 追記ブロックは末尾 + コメント目印で識別できるため衝突解決が容易。merge driver 追加までは必要ない

## Consequences

### Positive

- 拡張時の判断が予測可能 — 新 handler は 3 カテゴリのどれかに必ず属する
- agent から見て failure mode が分かりやすい — `daemon_*` の失敗は daemon 問題、`tool_*` の失敗は host 処理問題、`health` の失敗は bridge 自体の問題
- ADR-0002 を完全に守れる — upstream ファイルへの侵襲ゼロ、deshi コードは `src/deshi/**` と `container/skills/deshi-*/` に閉じる
- skill 実行時の動的コピー操作が不要 — `container/skills/` に直接置けば container から読める
- 2 階層命名により、agent から見える tool 名は短く保ちつつ、host 側の log / ファイル / handler key を見たときに deshi 系であることが即座にわかる

### Trade-offs

- カテゴリの判断が境界事例で迷う場合がある (例: deshi daemon を経由して host 処理をするケース)。原則は「直接の通信相手が deshi daemon なら `daemon_*`」「直接の通信相手が host のシステムリソースなら `tool_*`」とする
- MCP server を複数立てたくなった時には ADR を起こして本決定を見直す必要がある
- 2 階層命名により、各 `server.tool(...)` 呼び出しで agent 名と HTTP path 名の両方を書く必要がある (規約: `server.tool('X', ..., callHostTool('deshi_X', args))` を守れば機械的)
- `container/CLAUDE.md` への追記は upstream 由来ファイルへの侵入なので、upstream 側で同ファイルが大幅に変わると `/deshi-update-from-upstream` で衝突しうる (低頻度想定、衝突時は手動マージで吸収)

## See also

- ADR-0002 (namespace 隔離) — container 用 deshi コードを `container/skills/deshi-*/` に置くルートの根拠
- `.deshi/docs/mcp-tool-naming.md` — 詳細なルールと handler 追加手順
- `src/deshi/host-tools-server.ts` — dispatcher 実装
- `src/deshi/host-tools/health.ts` — 最初の handler (本 ADR の例として参照可能)
- `container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts` — container 内 MCP stdio
