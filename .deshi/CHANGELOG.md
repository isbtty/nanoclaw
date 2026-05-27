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
- 機能 Skill `/deshi-add-host-tools` (host-tools MCP bridge): `mcp__deshi__health` で生存確認 (工程 3)、`mcp__deshi__daemon_run_skill` + `mcp__deshi__daemon_poll_until_done` で deshi daemon に skill 実行を依頼し long polling で結果を受け取る (工程 5)。`container/CLAUDE.md` に使い方ガイドを `<!-- BEGIN/END deshi: host-tools MCP -->` ブロックで追記 (ADR-0009 で ADR-0002 の例外として記録)。
- ADR-0009: MCP tool 命名規則 (`health` / `daemon_*` / `tool_*` の 3 カテゴリ、2 階層命名)。
- LINE Messaging API channel adapter (`src/deshi/channels/line.ts`、native 実装、push API 統一、webhook server 内蔵)。`src/channels/deshi.ts` 経由で upstream barrel に 1 行で配線。`SUPPORTS_THREADS` map に `line: false` を追加。設計判断は jibot3 さん由来 (isbtty/deshi#259 参照)。
- 機能 Skill `/deshi-add-line` (LINE channel 有効化): コード presence check、LINE Developers Console 手順 (日英ラベル併記、1 ステップずつ user に確認しながら進行)、`.env` への credential 書き込み、`/deshi-setup-subdomain` (isbtty/deshi 側 admin skill) が発行した handoff package (subdomain / tunnel UUID / credentials JSON) の user 端末への配線、cloudflared を **user LaunchAgent** で常駐化 (sudo 不要、nanoclaw 本体と同じ常駐方式に揃える)、nanoclaw 再起動 + 疎通確認 (CF Access の path-based bypass を考慮した curl 判定)、auto-registration 経由の e2e 動作確認まで誘導する。subdomain / tunnel / CF Access apps の発行責任は `/deshi-setup-subdomain` に委譲する分離設計。MacBook 蓋閉じスリープ運用への注意点 (`pmset disablesleep` 解説) もトラブルシュートに収録。
