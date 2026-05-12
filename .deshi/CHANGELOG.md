# isbtty/nanoclaw — deshi 系メタディレクトリ CHANGELOG

`nanocoai/nanoclaw` upstream の追従とは独立に、`isbtty/nanoclaw` 側で発生した
deshi 系 (`.deshi/`, `src/deshi/`, `deshi-*` skill) の変更を記録する。
upstream の変更そのものは upstream の CHANGELOG / release notes を参照のこと。

形式: [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠。
バージョニング: deshi 独自の semver (詳細は [docs/design.md](docs/design.md) のバージョニング戦略を参照)。

## [Unreleased]

### Added

- `.deshi/` メタディレクトリ (`upstream-versions.json` / `skills-catalog.json` / `adr/` / `docs/` / `scripts/`) を移植 (from `dou-id/nanoclaw-deshi` `.dou/`)。
- `src/deshi/` namespace 雛形 (`channels/` / `providers/` の空 barrel)。
- barrel 衝突回避用の `.gitattributes` 設定 (`src/channels/index.ts`, `src/providers/index.ts` を `merge=deshi-barrel`)。
- 運用 Skill 2本 (`/deshi-update-from-upstream`, `/deshi-update-nanoclaw-official-channels`)。

### Changed

- 3 層 fork モデル (Tier C, 顧客 fork) を廃止。`isbtty/nanoclaw` は Tier A (upstream `nanocoai/nanoclaw`) + Tier B (`isbtty/nanoclaw` main) の 2 層構成。
- ADR-0004 (Tier C via fork) を削除。
- skill / namespace / 環境変数の接頭辞を `dou-` / `DOU_` から `deshi-` / `DESHI_` に変更。

### Notes

- 移植元: `dou-id/nanoclaw-deshi` の `v0.2.0` (`.dou/` 配下)。
- 詳細な経緯: isbtty/deshi#189 (予約語決定), isbtty/deshi#199 (移行工程)。
