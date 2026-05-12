# ADR-0002: deshi 固有ソースは src/deshi/** と container/skills/deshi-* に閉じる

- Status: accepted
- Date: 2026-04-28
- Refs: isbtty/deshi#98, isbtty/deshi#189, isbtty/deshi#199

## Context

deshi が独自に追加するコードを upstream のソースツリーに直接散らすと、`/deshi-update-from-upstream` 実行時の衝突箇所が増え、merge driver で機械解決できないケースが多発する。

## Decision

deshi 固有のソースは以下の namespace に閉じ込める。

- **TypeScript ソース**: `src/deshi/**` 配下
  - `src/deshi/index.ts` (root barrel)
  - `src/deshi/channels/index.ts` (deshi channels barrel)
  - `src/deshi/providers/index.ts`
  - `src/deshi/lib/`
- **Container Skills**: `container/skills/deshi-*` (prefix 必須)
- **Meta / 設定**: `.deshi/**`

upstream 管理ファイル (`src/channels/index.ts` 等) には `import './deshi.js';` の単一行のみを追加し、それ以外の deshi ロジックは `src/deshi/**` 側に隔離する。

## Consequences

- upstream merge での衝突点が `src/channels/index.ts` 等の barrel ファイル数行に局所化される。
- `verify-layout.ts` で `src/deshi/**` 外に deshi 固有コードが漏れていないかを CI 上で検出可能。
- `/deshi-update-from-upstream` の衝突解決ポリシーが `src/deshi/**` と `.deshi/**` を一律 `--ours` で扱える (機械適用しやすい)。

## See also

- 詳細議論: isbtty/deshi#98 (本文「ディレクトリ配置」セクション)
- 衝突解決ポリシー: ADR-0005
