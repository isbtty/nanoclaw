# ADR-0012: deshi MCP delegation fragment を spawn 時に deshi daemon から fetch する

- Status: accepted
- Date: 2026-05-27
- Refs: [isbtty/deshi#319](https://github.com/isbtty/deshi/issues/319), [isbtty/deshi#322](https://github.com/isbtty/deshi/pull/322)

## Context

[deshi ADR-0002](https://github.com/isbtty/deshi/blob/main/docs/adr/0002-skill-expose-flag.md) で deshi 側に `expose-to-nanoclaw` frontmatter を導入し、 ADR-0002 Decision 1 + nanoclaw 既存実装 ([`container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts`](../../container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts)) で nanoclaw container 内 agent が `daemon_list_skills` / `daemon_refresh_skills` 経由で expose 済み skill 一覧を動的取得できるようになった。残る課題は agent への **delegation 方針** ("業務知識不要なら自分で完結 / deshi 知識要るなら委譲") を伝える経路。

これまではこの方針を各 group の `CLAUDE.local.md` に手書きしていたが、 [isbtty/deshi#319](https://github.com/isbtty/deshi/issues/319) で以下が問題提起された:

- group が増えるたびに同じ方針を重複記述する必要がある
- 方針更新時に各 group の `CLAUDE.local.md` を一つずつ書き換える必要がある
- onboarding の摩擦が高い

nanoclaw には既に `claude-md-compose.ts` で `container.json` の `mcp_servers[name].instructions` を `.claude-fragments/mcp-<name>.md` として書き出し、 group の `CLAUDE.md` から import する仕組みがある。だが inline string が DB (`container_configs.mcp_servers`) に焼かれる構造のため、

- (a) **per-group 重複**: 各 group の DB row に同じ string を書き込む必要が残る
- (b) **drift**: fragment 本文を改善しても既存 group の DB row は更新されず、各 group ごとに migration が要る

の 2 つが解消されない。

## Decision

deshi が group の `mcp_servers` に含まれる場合、 `claude-md-compose.ts` は **spawn 時に deshi daemon `GET /nanoclaw-fragment` を fetch** し、得た markdown を `.claude-fragments/mcp-deshi.md` として書き出す。

### 1. fetch 経路

| layer | 役割 |
|---|---|
| deshi repo `.deshi/nanoclaw-delegation.md` | SoT。fragment 本文を保持 |
| deshi daemon `GET /nanoclaw-fragment` ([isbtty/deshi#322](https://github.com/isbtty/deshi/pull/322)) | 上記ファイルを毎回 read して text/markdown で返す。daemon 再起動不要 |
| nanoclaw `src/deshi/fetch-delegation-fragment.ts` | host 側 fetch utility (MCP tool 化しない — agent からは呼ばれない) |
| nanoclaw `src/claude-md-compose.ts` | spawn 時に上記 utility を呼び、結果を `.claude-fragments/mcp-deshi.md` に書く |

認証は host-tools-server 既存パターンと同じ Bearer (`<DESHI_DAEMON_DEVICE_SECRET>:nanoclaw`)。

### 2. 失敗時 fallback

deshi daemon に到達できない / 401 / 5xx 等で fetch が失敗した場合:

- 前回 spawn が残した `mcp-deshi.md` (cache) があればそれを再利用 (= filesystem を cache として使う)
- cache も無ければ `desired` に登録しない → 該当 fragment 無しで CLAUDE.md を組む (Claude Code は dangling import を silently ignore)

これにより daemon の一時停止中も group spawn が止まらず、最後に成功した fragment で運用が継続する。停止中の deshi 側 fragment 更新が反映されないのは既知の動作。

### 3. inline `instructions` との優劣

`mcp_servers.deshi.instructions` (inline) が設定されていても **auto-fetch を優先する** (deshi だけ inline 処理ループから除外)。理由は inline path の (a)(b) 問題を回避するのが本 ADR の目的そのものだから。意図的に override したいケースが将来出てきたら本 ADR を supersede する。

### 4. deshi を special-case する理由

汎用 `instructions_path` config を選ばなかった:

- nanoclaw は既に `src/deshi/host-tools/`, `src/deshi/inbound/` 等 deshi 専用の first-class integration を持つ。本 ADR で追加する special-case は既定路線
- deshi 以外の MCP server の fragment 本文を deshi repo に置く合理性は無い (slack-mcp なら slack-mcp 側に置くべき) ので、汎用化の実用恩恵が薄い
- 汎用 path 機構を入れるコスト (resolve ルール設計、相対 vs 絶対、test fixture) > deshi 一点 special-case のコスト

### 5. compose の async 化

`composeGroupClaudeMd` を async function に変更した。 caller (`buildMounts` → `spawnContainer`) も同期的だったため async に伝播させた。 spawn の I/O が 1 step 増える代償として fragment SoT の単一化を獲得する trade-off は許容範囲。

## Consequences

### Positive

- group が増えても delegation rule の重複記述は発生しない (auto-fetch なので `container.json` への追記すら不要)
- deshi repo の `.deshi/nanoclaw-delegation.md` を編集すれば次回 spawn から全 group に反映される (DB に焼かれないので drift なし)
- skill 追加と delegation rule 更新を deshi 側の同じ PR で扱える (rot しにくい)
- nanoclaw 側コードは `src/deshi/` 配下に閉じており、 deshi statt別 MCP server も同様の自動取得を必要とすれば類似の手段で実装できる

### Trade-offs

- spawn 時に deshi daemon への HTTP fetch が 1 回発生する (数十 ms オーダー)
- deshi daemon が長期停止しているまま **初回** spawn する group では `mcp-deshi.md` 無しで起動する (cache がまだ存在しないため)
- nanoclaw が deshi に依存する special-case が増える (汎用解ではない)
- `composeGroupClaudeMd` が async になり、 caller chain (`buildMounts` / `spawnContainer`) の signature が一段 async に伝播した

## See also

- [isbtty/deshi ADR-0002](https://github.com/isbtty/deshi/blob/main/docs/adr/0002-skill-expose-flag.md) — `expose-to-nanoclaw` frontmatter
- [isbtty/deshi#319](https://github.com/isbtty/deshi/issues/319) — 本機能の起点 issue
- [isbtty/deshi#322](https://github.com/isbtty/deshi/pull/322) — deshi 側 endpoint PR
- `src/claude-md-compose.ts` — compose 実装
- `src/deshi/fetch-delegation-fragment.ts` — fetch utility
- `src/container-runner.ts` — `buildMounts` / `spawnContainer` の async 伝播
