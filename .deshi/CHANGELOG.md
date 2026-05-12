# isbtty/nanoclaw — deshi 系メタディレクトリ CHANGELOG

`nanocoai/nanoclaw` upstream の追従とは独立に、`isbtty/nanoclaw` 側で発生した
deshi 系 (`.deshi/`, `src/deshi/`, `deshi-*` skill) の変更を記録する。
upstream の変更そのものは upstream の CHANGELOG / release notes を参照のこと。

形式: [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠。
バージョニング: deshi 独自の semver (詳細は [docs/design.md](docs/design.md) のバージョニング戦略を参照)。

## [Unreleased]

### Added

- 初期セットアップ — `.deshi/` メタディレクトリ (`upstream-versions.json` / `skills-catalog.json` / `adr/` / `docs/` / `scripts/`) を導入。
- `src/deshi/` namespace 雛形 (`channels/` / `providers/` の空 barrel)。
- barrel 衝突回避用の `.gitattributes` 設定 (`src/channels/index.ts`, `src/providers/index.ts` を `merge=deshi-barrel`)。
- 運用 Skill 2本 (`/deshi-update-from-upstream`, `/deshi-update-nanoclaw-official-channels`)。
