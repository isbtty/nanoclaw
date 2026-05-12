# ADR-0006: Tier 別バージョニング戦略

- Status: accepted
- Date: 2026-04-28
- Refs: isbtty/deshi#98, isbtty/deshi#189, isbtty/deshi#199

## Context

upstream / deshi で、それぞれ「何を真実とみなすか」「どう pin するか」「いつ bump するか」が異なる。これを一律に semver で揃えるのは無理があるため、Tier ごとに方針を分ける必要がある。

## Decision

Tier ごとに pin 方法と記録先を分ける。

| Tier | pin 対象 | 記録場所 | 更新タイミング |
|------|---------|---------|----------------|
| **A (upstream)** | upstream main / channels の SHA | `.deshi/upstream-versions.json` | `/deshi-update-from-upstream` または `/deshi-update-nanoclaw-official-channels` 実行時 |
| **B (deshi 独自)** | semver + monorepo tag (`v0.X.Y`) | `.deshi/skills-catalog.json` の `skills[].version` および `deshiRelease` | deshi が main に commit した時点で bump (自動採番は人間が判断) |

deshi 全体の release tag (`v0.X.Y-initial` 等) は monorepo tag として、Tier A pin と Tier B 全 Skill の状態を 1 点で固定する。

## Consequences

- Tier A は SHA pin のみで semver は付けない (upstream の releases に従属)。
- Tier B は個別 Skill の semver + 全体 monorepo tag の二重管理になるが、`skills-catalog.json` で機械的に整合チェック可能。
- `verify-layout.ts` で `skills-catalog.json` の `skills[].sources` と実ファイル配置の整合をチェックする。

## See also

- 詳細議論: isbtty/deshi#98 (本文「バージョニング戦略 (Tier 別)」セクション)
- スキーマ詳細: [docs/design.md](../docs/design.md)
- 旧 Tier C (顧客 fork) は #199 で廃止。
