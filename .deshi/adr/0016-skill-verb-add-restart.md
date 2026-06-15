# ADR-0016: Skill 命名の許可動詞に `restart` を追加する (ADR-0001 supersede)

- Status: accepted
- Date: 2026-06-15
- Supersedes: ADR-0001 (許可動詞集合のみ。prefix 固定方針は継承)
- Refs: isbtty/deshi#416

## Context

ADR-0001 は deshi 独自 Skill の命名を
`^deshi-(add|init|update|migrate|setup|run|manage|convert)-[a-z0-9-]+$`
(動詞 8 種) に固定した。

isbtty/deshi#416 の運用対応として、nanoclaw の常駐 (host / host-tools / container) を
最新ソースに refresh する運用スキルを新設する必要が生じた。意味的に最適な動詞は
**`restart`** だが、ADR-0001 の 8 種に含まれない。

代替として既存の `manage` を使う案 (`deshi-manage-nanoclaw`) も検討したが、
`manage` は意味が広すぎて「再起動」という操作意図が運用ループで判別しづらい。
再起動は今後も繰り返し発生する明確な操作カテゴリのため、正規動詞化する判断とした。

## Decision

ADR-0001 の許可動詞集合に **`restart`** を追加する。

新しい許可パターン:

- **動詞系**: `^deshi-(add|init|update|migrate|setup|run|manage|convert|restart)-[a-z0-9-]+$`
  - 追加例: `deshi-restart-nanoclaw`
- **Utility (非動詞)**: `^deshi-[a-z0-9-]+$` (ADR-0001 のまま不変)

`restart` の用途: 常駐サービス / コンテナの再起動・refresh を行う運用スキル。

## Consequences

- ADR-0001 の「prefix を最外に固定し upstream 公式 Skill と衝突させない」原則は
  そのまま継承。動詞集合のみ 8 → 9 種に拡張。
- `verify-layout.ts` (ADR-0007) は現状**未実装**のため、命名検証の正規表現コード変更は
  不要。実装時に本 ADR の動詞集合 (9 種) を反映すること。
- ADR-0001 は書き換えず、本 ADR が supersede する (履歴を残すため)。

## See also

- ADR-0001 (Skill 命名 prefix を最外に固定する) — 本 ADR が supersede
- ADR-0007 (verify-layout CI) — 未実装。実装時に動詞集合を同期
- `.claude/skills/deshi-restart-nanoclaw/` — 本 ADR で許容される初の `restart-` skill
