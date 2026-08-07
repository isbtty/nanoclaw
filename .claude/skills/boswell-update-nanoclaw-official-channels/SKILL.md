---
name: boswell-update-nanoclaw-official-channels
description: isbtty/nanoclaw の upstream/channels アダプタ群を `installed` 配列に基づいて check / update / reinstall する運用 Skill。
argument-hint: check | update | reinstall
---

# /boswell-update-nanoclaw-official-channels

## About

このSkillは、`isbtty/nanoclaw` に取り込み済みの **upstream の公式 channel adapter** 群を、上流 `nanocoai/nanoclaw` の `channels` branch から同期するための運用Skillです。

nanoclaw 本体(host + agent-runner + schema)の更新は `/boswell-update-from-upstream` の責務であり、本Skillは **channels branch のみ** を対象とします。両者は分離されており、`/boswell-update-from-upstream` が main を先に取り込んだ後、本Skillが内部から自動呼出される設計です。

本Skillは **3つのモード**(`check` / `update` / `reinstall`)を持ち、いずれも `.deshi/upstream-versions.json` の `upstream.channels.installed` 配列を**唯一の真実**として動作します。配列にない channel は upstream/channels に存在していても触りません(自動検出に頼らず、取込みは常に人間の意図を経由する方針)。

ソースファイルの実体改変はすべて `.deshi/scripts/install-official-channels.sh` に集約されます。Claude は `git show` や `cp` を直接叩かず、スクリプトに委譲します。

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│ nanocoai/nanoclaw (upstream)                                │
│   ├── main branch       ── /boswell-update-from-upstream の対象│
│   └── channels branch   ── 本Skill の対象                   │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ git fetch upstream channels
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ isbtty/nanoclaw (working tree)                              │
│                                                             │
│   .deshi/upstream-versions.json                             │
│     └── upstream.channels.installed: ["slack","discord",...]│
│                            │                                │
│                            ▼                                │
│   .deshi/scripts/install-official-channels.sh               │
│     └── installed 配列を読み、各 channel の関連ファイルを   │
│        upstream/channels から取り出して配置                 │
│                            │                                │
│                            ▼                                │
│   src/channels/, setup/, .claude/skills/add-<ch>/ 等        │
└─────────────────────────────────────────────────────────────┘
```

各モードの動作概要:

| モード | git fetch | スクリプト実行 | pnpm install | versions.json更新 | commit |
|---|---|---|---|---|---|
| `check` | yes | `--dry-run` で実行(read-only) | no | no | no |
| `update` | yes | yes | yes | yes(channels.sha / lastSyncedAt) | yes |
| `reinstall` | yes | `DESHI_CHANNELS_REF=<recorded_sha>` で実行 | no | no | no(dirty のまま返す) |

## Token usage

通常の実行で 30k-60k token 程度。`check` モードは差分表示のみのため軽量(10k-20k)。`update` は build / test 出力次第で 80k 程度まで伸びます。

## Goal

- `installed` 配列に列挙された channel adapter を、upstream/channels の最新(または記録時点)の状態に揃える
- 同期状況を `.deshi/upstream-versions.json` に記録し、後続の運用 Skill から参照可能にする
- 取込みの意図性(明示リスト主義)を維持し、見えない自動取り込みを起こさない

## Operating principles

以下は本Skillが守るべき不変条件です。逸脱しそうになったら一度止まって確認してください。

1. **ソースファイル改変は `.deshi/scripts/install-official-channels.sh` に集約する。** Claude が直接 `git show <ref>:path > dest` や `cp` で channel ファイルを書き換えてはいけない。スクリプト経由でのみ行う。
2. **`upstream.channels.installed` 配列が真実。** ここにない channel は upstream/channels に存在しても触らない。`src/channels/` に既にあっても、配列にない場合は本Skillの対象外。
3. **`installed` 配列の編集は人間の判断。** 新channel追加や廃止判断を本Skill が自動で行ってはいけない。Skill は通知するのみ。
4. **`upstream.main.sha` は `upstream/channels` の祖先である前提。** isbtty/nanoclaw は `merge-base(upstream/main, upstream/channels)` (共通祖先) を base ref に取る運用 (ADR-0008)。本Skillは `upstream.main.sha` が `upstream/channels` の祖先であることを sanity check するのみで、ここを「channels が main を追従しているか」のチェックには使わない。`/boswell-update-from-upstream` を先に走らせる前提。
5. **commit は1本にまとめる。** channel ごとに commit を切らない。
6. **reinstall は冪等。** 同じ記録 SHA に対して何度実行しても同じ結果になる。

## Step 0: 引数とモード判定

呼び出し時の `args` を確認し、3モードのいずれかに振り分けます。

- 引数なし or `check` → check モード(default)
- `update` → update モード
- `reinstall` → reinstall モード
- それ以外 → エラーで abort

```bash
MODE="${1:-check}"
case "$MODE" in
  check|update|reinstall) ;;
  *) echo "unknown mode: $MODE"; exit 2 ;;
esac
```

## Step 1: 整合性チェック(全モード必須)

以下4点を順に確認します。1つでも失敗したら abort します。

### 1-1. Clean working tree

```bash
git status --porcelain
```

出力が空でなければ abort。dirty な状態で channel ソースを書き換えると、ユーザーの未コミット変更を失う恐れがあります。

> "Working tree is not clean. Commit or stash your changes before running this skill."

### 1-2. upstream remote 検証

```bash
git remote get-url upstream
```

URL が `nanocoai/nanoclaw` を指していなければ abort。`origin` ではなく `upstream` という remote 名で運用しています。

> "upstream remote must point to nanocoai/nanoclaw. Run: git remote add upstream https://github.com/nanocoai/nanoclaw.git"

### 1-3. `.deshi/upstream-versions.json` 存在チェック

ファイルが存在し、`upstream.channels.installed` 配列が読めることを確認。読めなければ abort。

> ".deshi/upstream-versions.json is missing or malformed. Run /boswell-update-from-upstream first to initialize."

### 1-4. `upstream.main.sha` の ancestor sanity check

isbtty/nanoclaw は `merge-base(upstream/main, upstream/channels)` を base ref に取る運用 (ADR-0008)。`upstream.main.sha` は定義上 `upstream/channels` の祖先であるはずなので、それが本当に成立しているかを sanity check として確認します。

```bash
git fetch upstream main channels
RECORDED_MAIN_SHA=$(jq -r '.upstream.main.sha' .deshi/upstream-versions.json)
CHAN_SHA=$(git rev-parse upstream/channels)
git merge-base --is-ancestor "$RECORDED_MAIN_SHA" "$CHAN_SHA"
```

exit code が 0 でなければ `.deshi/upstream-versions.json` が壊れているか、`/boswell-update-from-upstream` が `--target` で channels の祖先でない ref を取り込んでしまった状態です。channel 取り込みに進めないため abort します。

> "upstream.main.sha is not an ancestor of upstream/channels — versions.json may be inconsistent. Re-run /boswell-update-from-upstream (default = merge-base) first."

加えて、`upstream.main.policy` が `"merge-base"` の場合は、`RECORDED_MAIN_SHA` が現時点の `merge-base(upstream/main, upstream/channels)` と一致するかを警告チェックします (一致しなければ「upstream の HEAD が動いて共通祖先が前進している」状態。warn のみ、abort はしない):

```bash
RECORDED_POLICY=$(jq -r '.upstream.main.policy // "legacy"' .deshi/upstream-versions.json)
if [ "$RECORDED_POLICY" = "merge-base" ]; then
  CURRENT_BASE=$(git merge-base upstream/main upstream/channels)
  if [ "$RECORDED_MAIN_SHA" != "$CURRENT_BASE" ]; then
    echo "WARN: recorded merge-base ($RECORDED_MAIN_SHA) differs from current ($CURRENT_BASE). Consider running /boswell-update-from-upstream."
  fi
fi
```

## Step 2: モード別処理

### 2-A. check モード(read-only)

`installed` 配列を読み込み、以下3つの差分を計算して表示します。スクリプトは `--dry-run` で呼び出してファイル変更は一切行いません。

```bash
bash .deshi/scripts/install-official-channels.sh --dry-run
```

スクリプトの出力に加えて、以下の追加情報を集約して表示します:

#### (a) 記録 SHA と upstream/channels HEAD の比較

```bash
RECORDED_SHA=$(jq -r '.upstream.channels.sha' .deshi/upstream-versions.json)
HEAD_SHA=$(git rev-parse upstream/channels)
```

両者が一致すれば「up to date」。一致しない場合は、`installed` 配列の各 channel に関連するファイル(`src/channels/<ch>*.ts`, `setup/install-<ch>.sh`, `setup/channels/<ch>.ts`, `.claude/skills/add-<ch>/`)に絞って変更ファイル数を集計します。

```bash
git diff --name-only "$RECORDED_SHA".."$HEAD_SHA" -- src/channels setup .claude/skills/add-*
```

出力形式の例:

```
channels branch: <N> commits behind (recorded <SHORT> → HEAD <SHORT>)
Changed files in installed channels: <N>
  slack:    2 files changed
  discord:  1 file changed
  telegram: 4 files changed
```

#### (b) 新channel通知(upstream に出現、installed 未登録)

upstream/channels の `src/channels/` 直下のファイル名から channel 名を抽出し、`installed` 配列に含まれていないものを列挙します。これは**通知のみ**で、`installed` 配列を自動編集してはいけません。

```
New channels available upstream (not in `installed`):
  - emacs
  - <その他>

To adopt one, edit .deshi/upstream-versions.json `upstream.channels.installed`
manually and run /boswell-update-nanoclaw-official-channels update.
```

#### (c) 廃止検知(installed にあるが upstream に消えた)

`installed` の各 channel に対し、upstream/channels HEAD で該当ファイルが存在するか確認します。消えていれば警告。

```
WARNING: channel(s) in `installed` no longer exist upstream:
  - <channel name>

Manual decision required: remove from `installed` and run reinstall, or pin to
an older `upstream.channels.sha`.
```

check モードはここで終了します。exit 0。

### 2-B. update モード

#### 2-B-1. backup branch 作成

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
git branch "backup/pre-channel-update-$TS"
```

#### 2-B-2. install スクリプト実行

```bash
bash .deshi/scripts/install-official-channels.sh
```

スクリプトが `installed` 配列を読み、upstream/channels から各 channel の関連ファイルを取り出して配置します。`package.json` の依存も差分抽出方式で追加されます。Claude はスクリプト出力を読むだけで、個別ファイルには直接触れません。

スクリプトが non-zero で終了したら abort し、backup branch への戻し方をユーザーに案内します。

#### 2-B-3. pnpm install

```bash
pnpm install
```

`@chat-adapter/*` 各パッケージが `package.json` の pin 通りにインストールされます。

**`minimumReleaseAge: 4320`(3日)による install 失敗の取り扱い:** pnpm が一部 `@chat-adapter/*` を「too new」として拒否する場合があります。これは abort 事由ではありません。pnpm のエラー出力から該当パッケージ名を抽出し、警告として記録した上で処理を継続します。

```
WARNING: pending due to pnpm minimumReleaseAge:
  - @chat-adapter/slack@1.4.2 (released < 3 days ago)
This channel will be retried at the next /boswell-update-nanoclaw-official-channels update.
```

旧スキーマには `pending-<version>` マーク用のフィールドがありましたが、新スキーマでは記録場所がありません(adapter version は `package.json` が真実)。代わりに **commit メッセージに pending channel 名を明記**することで、次回追従時の再試行を人間が判断できるようにします。

#### 2-B-4. 検証(build, test)

```bash
pnpm run build
pnpm test
cd container/agent-runner && bun install && bun test && cd -
```

いずれかが失敗したら abort。backup branch への戻し方をユーザーに案内します。

#### 2-B-5. `.deshi/upstream-versions.json` 更新

更新するフィールドは2つだけ:

- `upstream.channels.sha` ← `git rev-parse upstream/channels`
- `upstream.channels.lastSyncedAt` ← 現在時刻(ISO8601, ローカルTZ)

`installed` 配列は触りません(人間の判断のみ)。`upstream.main.*` も触りません(これは `/boswell-update-from-upstream` の責務)。

#### 2-B-6. commit(1本)

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(channels): sync upstream/channels to <SHA short>

Synced channels from upstream/channels at <SHA>.
Installed: slack, discord, telegram, ...

Pending (deferred by pnpm minimumReleaseAge):
  - @chat-adapter/slack (will retry next sync)
EOF
)"
```

pending がない場合は "Pending: none" と書きます。pending 行を必ず含めることで、次回追従担当(人間 or Claude)がログを見れば再試行対象を把握できます。

branch 作成・push・PR 作成はこのSkillの責務外です。呼び出し側(典型的には `/boswell-update-from-upstream` か手動運用)が担います。

### 2-C. reinstall モード

記録された `upstream.channels.sha` 時点の状態に channel ソースを戻すモードです。新環境のセットアップ時、`upstream-versions.json` で固定された再現可能な state を確実に再構成するために使います。

#### 2-C-1. backup branch 作成

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
git branch "backup/pre-channel-update-$TS"
```

#### 2-C-2. install スクリプトを記録 SHA で実行

```bash
RECORDED_SHA=$(jq -r '.upstream.channels.sha' .deshi/upstream-versions.json)
DESHI_CHANNELS_REF="$RECORDED_SHA" bash .deshi/scripts/install-official-channels.sh
```

スクリプトは環境変数 `DESHI_CHANNELS_REF` が指定されればそれを使い、なければ `upstream/channels` HEAD を使います。

#### 2-C-3. pnpm install は実行しない

reinstall モードでは `pnpm install` を**走らせません**。lockfile が真実であり、ソース側のみ記録 state に揃えるのが目的です。

#### 2-C-4. versions.json 更新も commit もしない

結果は dirty working tree のまま返します。commit するか追加で何かするかは呼び出し側の判断です。

完了メッセージ例:

```
Reinstalled channels at recorded SHA <RECORDED_SHA short>.
Working tree is now dirty (intentional). Review with `git diff` and decide
whether to commit or discard.
```

reinstall は **冪等** です。同じ `.deshi/upstream-versions.json` の状態に対して何度実行しても、結果の working tree は同一になります。

## Rollback

何か問題が起きた場合、Step 2-B-1 / 2-C-1 で作成した backup branch から復旧できます。

```bash
# 直前の状態に戻す
git reset --hard backup/pre-channel-update-<TS>

# pnpm の状態も含めて完全に戻す
git reset --hard backup/pre-channel-update-<TS>
pnpm install --frozen-lockfile
```

`pnpm install` 失敗で update が途中停止した場合は、すでに channel ソースだけ書き換わっている可能性があります。同じ手順で backup branch に戻してください。

`.deshi/upstream-versions.json` を更新したのに後段の検証で失敗した場合も同じです。backup branch には更新前の `versions.json` が残っています。

## Related skills

| Skill | 対象 | 関係 |
|---|---|---|
| `/boswell-update-nanoclaw-official-channels`(本Skill) | upstream/channels の adapter | `installed` 配列に明示された channel のみ |
| `/boswell-update-from-upstream` | upstream/main(host + agent-runner + schema) | 任意のタイミング、本Skill を内部で自動呼出 |

**順序原則:** `/boswell-update-from-upstream` を先に走らせて共通祖先 (`merge-base(upstream/main, upstream/channels)`) を `upstream.main.sha` に書き込み、その後に本Skillで channels を同期します。逆順だと Step 1-4 の sanity check で abort することがあります(意図した安全弁、ADR-0008)。

`/boswell-update-from-upstream` は内部から本Skillを `update` モードで自動呼出します。手動で本Skillを単独実行するのは、check モードで状況を確認する場合などです。
