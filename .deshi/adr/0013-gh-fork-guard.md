# ADR-0013: gh CLI の cross-fork 誤投稿対策 (`gh-fork-guard`) — nanoclaw 側

- Status: accepted
- Date: 2026-05-28
- Refs: nanocoai/nanoclaw#2623 (closed, redacted), isbtty/deshi#332 (ADR-0006)

## Context

`isbtty/nanoclaw` は `nanocoai/nanoclaw` の public fork で、clone は通常以下の
2 remote 構成になる:

- `origin` = `isbtty/nanoclaw` (弊社管理 fork)
- `upstream` = `nanocoai/nanoclaw` (public OSS)

GitHub CLI (`gh`) の `gh pr create` / `gh issue create` 等の write 系コマンドは、
**fork detection** ロジックにより `--repo` 未指定の場合 default で **parent
repo (= upstream)** を base/target に選ぶ。非対話モード (Claude Code の Bash
tool / CI 等) では prompt が抑制されるため、`--repo` 未指定で write 系を叩くと
**気付かないうちに public OSS へ内部開発内容が投稿される事故**が発生する。

実際に 2026-05-27、`isbtty/nanoclaw` の `feature/deshi-259-add-line-channel`
ブランチを `gh pr create` (`--repo` 未指定) で出した結果 `nanocoai/nanoclaw#2623`
に PR が作成された (約 1 分以内に close、title/body を `"miss pr"` に redact、
GitHub Support に object purge 依頼済)。`isbtty/nanoclaw` 側こそ
この事故の直接の発生元。

## Decision

`isbtty/deshi` 側で同問題を解決するために導入した 3 層のガードレール
([isbtty/deshi/docs/adr/0006-gh-fork-guard.md](https://github.com/isbtty/deshi/blob/main/docs/adr/0006-gh-fork-guard.md)、
PR #332) を **本 repo (`isbtty/nanoclaw`) にも同じ構成で導入する**。

### 実体 (scripts/dev/ に配置、deshi 側と同一)

- `scripts/dev/gh-fork-guard.sh` — `gh` wrapper。fork clone で write 系コマンド
  が `--repo` 未指定 + `gh-resolved` 未設定で叩かれた場合のみ block
- `scripts/dev/install-gh-fork-guard.sh` — `~/.local/bin/gh` への symlink install
  + PATH 設定 (端末-wide、idempotent)
- `scripts/dev/setup-fork-clone.sh` — `origin` URL から `<owner>/<repo>` を自動
  導出して `gh repo set-default` (clone ごと、idempotent、defensive)

### setup.sh への組み込み

bootstrap 開始直後 (`detect_platform` の直後) に以下 2 ステップを実行:

1. `install-gh-fork-guard.sh` — wrapper を端末-wide で設置
2. `setup-fork-clone.sh` — この clone の gh default を fork に pin

両者とも `if/else` で wrap し、失敗しても `setup.sh` 全体を止めない
(`set -euo pipefail` 配下で動作するため)。

## Consequences

### Positive
- fork での `gh` 誤爆事故が構造的に発生不能
- `bash setup.sh` を叩く既存の onboarding 儀式に乗っかるため、新メンバーが
  特別な手順を覚える必要なし
- deshi 側 (isbtty/deshi PR #332) と同じ 3 層構成 / 同じ scripts なので、
  両 repo を行き来する dev にとって振る舞いが一貫する

### Negative
- scripts が 2 repo に重複 (deshi と nanoclaw)。長期的には共通化したいが
  現状は dev 自身の手元で `bash <deshi-clone>/scripts/dev/install-gh-fork-guard.sh`
  を叩いた方が早いケースもあるため、自己完結の重複を許容
- wrapper のバグが `gh` 全体を壊すリスク (`GH_FORK_GUARD_DISABLE=1` env var で
  bypass 可、defensive 実装で軽減)

## Rollout

新規 clone では `bash setup.sh` を叩けば Layer 1 + Layer 2 が自動で立ち上がる。

既存 clone を本 PR merge を待たず即時防御したい場合は cd して 1 行:

```bash
gh repo set-default "$(git remote get-url origin | sed 's|.*github.com[:/]||; s|\.git$||')"
```

## 関連

- nanocoai/nanoclaw#2623 (closed, redacted) — 直接の incident
- GitHub Support privacy ticket — object purge 依頼 (進行中)
- isbtty/deshi#332 / [docs/adr/0006-gh-fork-guard.md](https://github.com/isbtty/deshi/blob/feature/setup-base/docs/adr/0006-gh-fork-guard.md) — deshi 側で同手当を導入 (本 ADR の元)
