# ADR-0003: deshi 独自 Skill は main にコミット済みで配布する

- Status: accepted
- Date: 2026-04-28
- Refs: isbtty/deshi#98, isbtty/deshi#189, isbtty/deshi#199

## Context

upstream nanoclaw は `channels` ブランチに channel adapter を分離して配布する方式 (`/add-<channel>` Skill が `git fetch origin <branch>` でコピー) を採っている。deshi が追加する Skill (例: 将来の `/deshi-add-line`) も同じ方式を採るかどうかが論点になった。

## Decision

deshi の独自 Skill は **`main` に直接コミット済みで配布する**。channels ブランチ方式は採用しない。

理由:
- `isbtty/nanoclaw` の利用者は基本的に isbtty/deshi 開発者と関係者のみで、upstream のように OSS コミュニティ全員に配るわけではない。多人数向けの「選択的インストール」ニーズが弱い。
- channels ブランチ方式を採ると、deshi 側で別ブランチ管理が増える (deshi 用ブランチを長期保守) コストに見合わない。

## Consequences

- deshi Skill 追加 = `feature/add-deshi-<name>` ブランチ → `main` への PR、で完結する単純な flow になる。
- `installed` 配列方式 (upstream/channels の取込制御) は upstream Tier A だけに適用される。

## See also

- 詳細議論: isbtty/deshi#98 (本文「全体アーキテクチャ」「ディレクトリ配置」セクション)
