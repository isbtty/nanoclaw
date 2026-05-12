# ADR-0007: .deshi/scripts/verify-layout.ts を CI 必須化する

- Status: accepted
- Date: 2026-04-28
- Refs: isbtty/deshi#98

## Context

ADR-0001〜0006 で定めたルール (命名規則、namespace 配置、catalog と実ファイルの整合、barrel エントリの存在) は、人間が PR で見落とすと容易に破綻する。手動チェックでは持続しないため、機械的に検証する仕組みが必要。

## Decision

`.deshi/scripts/verify-layout.ts` を実装し、以下を **CI 必須 job として** 実行する。1つでも違反があれば CI を red にする。

検証項目:
1. **命名規則 (ADR-0001)**: `.claude/skills/deshi-*/` の各ディレクトリ名が正規表現に適合しているか。
2. **namespace 配置 (ADR-0002)**: deshi 固有コードが `src/deshi/**` および `container/skills/deshi-*` 以外に漏れていないか。
3. **barrel エントリ (ADR-0005)**: `src/channels/index.ts` 等に `import './deshi.js';` が存在し、`src/channels/deshi.ts` から `src/deshi/channels/index.ts` への参照が有効か。
4. **catalog 整合 (ADR-0006)**: `.deshi/skills-catalog.json` の `skills[].sources` に列挙されたパスが実在し、かつそれ以外の deshi Skill が存在しないか (双方向チェック)。
5. **upstream-versions.json の妥当性**: `installed` 配列の各 channel が upstream/channels に実在するか。

## Consequences

- 上記ルール違反は merge 前に必ず検出される (人間レビューに依存しない)。
- `verify-layout.ts` 自体の保守責任は `@isbtty/deshi-core` チームが負う。
- 将来 ADR を追加した際、検証項目を追記する習慣 (ADR と verify-layout.ts のペア更新) が必要。

## See also

- 詳細議論: isbtty/deshi#98 (本文「設計の一貫性チェック」セクション、ADR 主要ポイント)
- 検証対象 ADR: ADR-0001, ADR-0002, ADR-0005, ADR-0006
- 実装: `.deshi/scripts/verify-layout.ts` (未実装、別 issue で対応)
