# ADR-0001: Skill 命名 prefix を最外に固定する

- Status: accepted
- Date: 2026-04-28
- Refs: isbtty/deshi#98, isbtty/deshi#189, isbtty/deshi#199

## Context

`isbtty/nanoclaw` は upstream (`nanocoai/nanoclaw`) を fork し、deshi 独自の運用 Skill と機能 Skill を継続的に追加していく。upstream 公式 Skill との衝突を避ける必要がある。

## Decision

Skill 名の最外 prefix を以下に固定する。

- **動詞系**: `^deshi-(add|init|update|migrate|setup|run|manage|convert)-[a-z0-9-]+$`
  - 例: `deshi-add-line`、`deshi-update-from-upstream`
- **Utility (非動詞)**: `^deshi-[a-z0-9-]+$`
  - 例: `deshi-feedback-gh`

## Consequences

- upstream 公式 Skill (`add-slack` 等) との名前空間衝突が物理的に起きない。
- 動詞 prefix 8種に限定することで、運用ループでの判別容易性を確保。
- `verify-layout.ts` (ADR-0007) で CI 上で命名規則違反を検出する。

## See also

- 旧 3 層 fork モデル (Tier C 顧客 fork) は #199 で廃止された。当初は `dou-<customerCode>-...` の Tier C 命名規則が存在したが、現在は単一 fork (`isbtty/nanoclaw`) で運用するため不要。
- 詳細議論: isbtty/deshi#98 (本文「Skill 実装ルール」セクション)
- ディレクトリ配置: [docs/design.md](../docs/design.md)
