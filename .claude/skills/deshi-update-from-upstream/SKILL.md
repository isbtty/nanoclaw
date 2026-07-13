---
name: deshi-update-from-upstream
description: isbtty/nanoclaw に nanocoai/nanoclaw upstream の更新を取り込み、衝突を機械的に解決し、metadata と channel を再同期して deshi tag を打つ skill
argument-hint: [--yes] [--target <ref>] [--no-channels] [--no-validate]
---

# /deshi-update-from-upstream

## About

本 Skill は `isbtty/nanoclaw`(deshi 系の運用 fork)が `nanocoai/nanoclaw` upstream の更新を取り込むための Skill です。

upstream が公開している `/update-nanoclaw` skill をベースにし、deshi 独自の運用要件を上乗せしたラッパーとして動作します。具体的には次を追加で行います:

1. deshi 衝突解決ポリシーの機械適用(`src/deshi/**` `.deshi/**` 等の保護、`src/channels/index.ts` の union merge など)
2. `.deshi/upstream-versions.json` の自動更新(`upstream.main.*` と `deshi.*`)
3. `[BREAKING]` 検出時の ADR 自動起票 + 3択フロー
4. `/deshi-update-nanoclaw-official-channels update` の自動連鎖呼出
5. `deshi.currentTag` の patch bump 提案と annotated tag 作成
6. deshi-barrel custom merge driver の git config への自動登録(初回のみ)

任意のタイミングで実行できます。`--yes` モードで cron / launchd から自動起動することも、必要に応じて手動で走らせることも可能です。ただし BREAKING の取込判断 / `main` への直接 push / validation 失敗時の recovery は常に人間判断を要します(自動化禁止)。

## How it works

```
                  ┌───────────────────────────────────────┐
                  │  /deshi-update-from-upstream (this)   │
                  └──────────────────┬────────────────────┘
                                     │
              ┌──────────────────────┼─────────────────────┐
              ▼                      ▼                     ▼
   upstream `/update-nanoclaw`  deshi 衝突解決      .deshi/upstream-versions.json
   (fetch / preview / merge)    ポリシーの機械適用   と deshi tag の更新
                                     │
                                     ▼
                       /deshi-update-nanoclaw-official-channels update
                       (channel branch の再適用、失敗は non-fatal)
                                     │
                                     ▼
                       deshi tag bump 提案 → annotated tag
```

upstream `/update-nanoclaw` の **fetch / preview / merge / validate** の骨組みは温存し、衝突発生時に deshi ポリシーを上乗せするかたちで介入します。

## Token usage

おおむね 80k–140k tokens / run。BREAKING ADR を起票するケースで上振れし、衝突が `src/deshi/**` と `.deshi/**` に閉じるケースでは 60k 前後で収まります。`--yes` モードでも diff 量に比例するため、preview の段階で diff が 5k 行を超える場合は手動モードへの切替を検討してください。

## Rollback

このSkill は破壊的操作を行う前に必ず以下を取得します:

- backup branch: `deshi/backup/pre-upstream-sync-<timestamp>`
- backup tag: `deshi-backup-pre-upstream-<timestamp>`(annotated)

何かが壊れたら、作業ブランチ上で:

```bash
# 作業ブランチを backup tag の時点に戻す (作業ブランチに居る前提)
git reset --hard deshi-backup-pre-upstream-<timestamp>

# .deshi/upstream-versions.json も backup tag 時点に戻る(同 commit に含まれているため)

# 作業ブランチごと捨てて新しく切り直す場合:
# git checkout main
# git branch -D <作業ブランチ>
# git checkout -b <新しい作業ブランチ>
```

`main` への push はこのSkill では行わないため、最悪でもローカル / 作業ブランチ上の損傷で済みます。push は人間が PR レビュー後に実行してください。

## Goal

upstream の更新を `isbtty/nanoclaw` の `main` に取り込み、`.deshi/upstream-versions.json` と deshi tag をその状態の真実として残すこと。

## Operating principles

- **取り込み base は共通祖先**: 取り込み対象 commit の default は `git merge-base upstream/main upstream/channels`。`upstream/main` の HEAD ではなく、main と channels の共通祖先まで戻すことで、`upstream/channels` の ancestor チェック (`/deshi-update-nanoclaw-official-channels`) が必ず通り、安定版運用ポリシーを Skill レベルで実装する (詳細は ADR-0008)。`--target <ref>` で明示指定可能。
- **tag は判定に使わない**: 共通祖先には tag が無い場合が多いため、本Skill 内では `git describe` 等の tag 解決を一切行わない。branch 名 / commit message / metadata はすべて SHA ベース。
- **deshi namespace は upstream merge で絶対に失わない**: `src/deshi/**` と `.deshi/**` は常に `--ours`。
- **upstream の docs は upstream を真実とみなす**: `CLAUDE.md` / `docs/**` は `--theirs`。deshi 固有の docs は `.deshi/docs/**` に分離されている前提。
- **channel adapter のソースは deshi 側を信じない**: `src/channels/<name>.ts` と `package.json` 内の `@chat-adapter/*` 行は `--ours` で残し、後続の `/deshi-update-nanoclaw-official-channels update` が channel branch から再適用して整合させる。
- **`src/channels/index.ts` だけは union**: upstream の barrel と deshi 側 install 結果の両方の import 行を残す (.gitattributes の deshi-barrel merge driver 経由で機械解決)。
- **`src/channels/slack.ts` に diff があれば `slack-instances.ts` へ反映確認 (ADR-0018)**: `src/deshi/channels/slack-instances.ts` の factory は `src/channels/slack.ts` の factory の**ミラー**。取込 range (Step 2 の preview) で `src/channels/slack.ts` が touch されていたら、その diff (permalink enrichment / resolveChannelName / fetchThreadBackfill / bridge の組み立て) を `slack-instances.ts` の factory に反映する必要があるか必ず確認する。`slack.ts` 自体は `--ours` で残る (上記 channel adapter ソースの原則) が、ミラー側の追随はこの Skill が機械解決できないため人間判断で行う。
- **BREAKING は人間に必ず判断させる**: `--yes` モードでも ADR ファイルを `.deshi/adr/` に物理的に残し、commit に含めることでレビューを強制する。
- **`main` には push しない / `main` で実行しない**: 本Skill は `main` から派生した作業ブランチで実行する前提 (Step 0-1)。merge は作業ブランチに対して行い、最終的に `main` への PR を出すところで止まる。
- **連鎖呼出の失敗は fatal にしない**: `/deshi-update-nanoclaw-official-channels update` が失敗してもこのSkill 全体は continue。warn を出し、人間が単独で再実行できるよう案内する。

## Inputs

このSkill が読む / 書くもの:

| path | 役割 |
|---|---|
| `.deshi/upstream-versions.json` | 入力 + 出力。`upstream.main.sha` / `upstream.main.policy` / `deshi.*` を本Skill が更新 (`upstream.main.tag` は使わない) |
| `.deshi/adr/` | 出力。BREAKING 検出時に `NNNN-upstream-<sha>-breaking.md` を起票 |
| `.deshi/policies/conflict-resolution.json` | 入力(任意)。存在すればポリシー override に使用 |
| `src/deshi/**` | 保護対象 |
| `.deshi/**` | 保護対象(本Skill が書く `.deshi/upstream-versions.json` と `.deshi/adr/**` を除く) |
| `src/channels/index.ts` | union merge 対象 (.gitattributes 経由) |
| `src/channels/<name>.ts` | `--ours` |
| `package.json` の `@chat-adapter/*` | `--ours` |
| `CLAUDE.md` / `docs/**` | `--theirs` |

`--yes` フラグを渡された場合は AskUserQuestion をスキップし、各分岐の default を採用します。ただし「BREAKING ADR の起票」と「作業ブランチに commit して終了」までは行うが、`main` への merge / push は人間に委ねます。

## Step 0 — Sanity check & 初期セットアップ

### 0-1. 基本チェック

isbtty/nanoclaw の運用ポリシーとして、upstream 追従は **`main` ブランチで直接行わず、`main` から派生した作業ブランチで実行 → `main` への PR を作る** 前提です (main を直接書き換えない)。

```bash
# Working tree が clean か
git status --porcelain
# clean でなければ abort。stash も自動では行わない(意図しない変更の取り込みを避ける)。

# 現在のブランチが main 以外であること
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "${CURRENT_BRANCH}" = "main" ]; then
  echo "ERROR: 現在 main ブランチに居ます。main では直接 upstream 追従を行わない方針です。"
  echo "       例: git checkout -b feature/sync-upstream-<date>  などで作業ブランチを切ってから再実行してください。"
  exit 1
fi
# main 以外であれば OK (どの作業ブランチでも実行可能、Skill が新しい sync branch を切る)

# main が origin と乖離していないこと (作業ブランチが古い main から派生していると merge 範囲がズレるため警告)
git fetch origin main 2>/dev/null || true
LOCAL_MAIN=$(git rev-parse main 2>/dev/null || echo "")
REMOTE_MAIN=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -n "${LOCAL_MAIN}" ] && [ -n "${REMOTE_MAIN}" ] && [ "${LOCAL_MAIN}" != "${REMOTE_MAIN}" ]; then
  echo "WARN: ローカル main (${LOCAL_MAIN:0:7}) が origin/main (${REMOTE_MAIN:0:7}) と乖離しています。"
  echo "      git pull origin main で揃えてから再実行することを推奨します。"
  # AskUserQuestion で proceed/abort を確認 (--yes モードでは proceed)
fi

# upstream remote が登録されているか
git remote get-url upstream 2>/dev/null \
  || git remote add upstream https://github.com/nanocoai/nanoclaw.git

# `.deshi/upstream-versions.json` が存在するか
test -f .deshi/upstream-versions.json
# 無ければ abort。
```

`--yes` モードでも「working tree dirty」「main ブランチに居る」「upstream remote 不在」「versions.json 不在」は **必ず abort** します。「main 乖離」は warn のみ (proceed)。

### 0-2. deshi-barrel merge driver の自動登録

`.gitattributes` で `src/channels/index.ts` 等に割り当てている custom merge driver `deshi-barrel` の中身が、現在の git config に未登録ならば自動登録します。git のセキュリティモデル上、リポジトリから自動登録できないため、初回 Skill 実行時にここでセットアップします。

```bash
if ! git config --get merge.deshi-barrel.driver >/dev/null 2>&1; then
  echo "Registering deshi-barrel custom merge driver to local git config..."
  git config merge.deshi-barrel.name "deshi barrel union merge driver"
  git config merge.deshi-barrel.driver ".deshi/scripts/merge-barrel.sh %O %A %B %P"
fi
```

冪等です。既に登録済みなら no-op で通過します。`--yes` モードでも自動実行して問題ありません(ローカル git config を書き換えるだけ、リモートには影響なし)。

## Step 1 — 現状スナップショットを撮る

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_BRANCH="deshi/backup/pre-upstream-sync-${TIMESTAMP}"
BACKUP_TAG="deshi-backup-pre-upstream-${TIMESTAMP}"

git branch "${BACKUP_BRANCH}"
git tag -a "${BACKUP_TAG}" -m "Pre-upstream-sync backup at ${TIMESTAMP}"
```

`.deshi/upstream-versions.json` から下記を読んで保持しておく(後で diff / metadata 更新に使う):

- `PREV_MAIN_SHA = upstream.main.sha`
- `PREV_POLICY = upstream.main.policy` (`"merge-base"` / `"target"` / null。null なら旧形式とみなす)
- `CURRENT_DESHI_TAG = deshi.currentTag` (null の場合あり)

`upstream.main.tag` は本Skill では参照しない (tag はチェックしない)。

## Step 2 — upstream を fetch して取り込み対象を確定する

```bash
git fetch upstream main channels

UPSTREAM_MAIN_SHA=$(git rev-parse upstream/main)
UPSTREAM_CHANNELS_SHA=$(git rev-parse upstream/channels)
MERGE_BASE_SHA=$(git merge-base upstream/main upstream/channels)
```

取り込み対象 `TARGET_SHA` と policy を決定する:

```bash
if [[ -n "${TARGET_REF:-}" ]]; then
  # --target <ref> が指定された場合
  TARGET_SHA=$(git rev-parse "${TARGET_REF}")
  TARGET_POLICY="target"

  # channels の祖先でない ref を取り込むと後段の channels skill が abort するので予防線
  if ! git merge-base --is-ancestor "${TARGET_SHA}" upstream/channels; then
    echo "WARN: --target ${TARGET_REF} (${TARGET_SHA:0:7}) is not an ancestor of upstream/channels."
    # AskUserQuestion で proceed/abort を確認 (--yes モードでは abort)
  fi
else
  # 無指定 (default): 共通祖先を取り込む
  TARGET_SHA="${MERGE_BASE_SHA}"
  TARGET_POLICY="merge-base"
fi
```

`TARGET_REF` は本Skill 起動時に `--target <ref>` 引数から抽出してシェル変数に入れておく (引数パースは Step 0 の sanity check で実施)。

preview を出す:

```bash
echo "Upstream main HEAD : ${UPSTREAM_MAIN_SHA:0:7}"
echo "Upstream channels  : ${UPSTREAM_CHANNELS_SHA:0:7}"
echo "Merge-base         : ${MERGE_BASE_SHA:0:7}"
echo "Target (taken)     : ${TARGET_SHA:0:7}  [policy=${TARGET_POLICY}]"
echo "Previous main.sha  : ${PREV_MAIN_SHA:0:7}  [policy=${PREV_POLICY:-legacy}]"
echo

# Range commit log
git log --oneline "${PREV_MAIN_SHA}..${TARGET_SHA}"

# 影響ファイル概要
git diff --stat "${PREV_MAIN_SHA}..${TARGET_SHA}"

# deshi が保護したいパスへの upstream の touch を一覧
git diff --name-only "${PREV_MAIN_SHA}..${TARGET_SHA}" -- \
    'src/channels/**' 'package.json' 'CLAUDE.md' 'docs/**' 'src/router.ts'
```

`PREV_MAIN_SHA == TARGET_SHA` なら **No-op** として終了:

- 共通祖先運用では「main HEAD が前進しても channels が追従していなければ共通祖先は動かない」ため、main HEAD だけ進んだ場合も No-op になる (これは仕様、ADR-0008 参照)
- `.deshi/upstream-versions.json` の `lastSyncedAt` / `lastSyncedBy` だけを更新する commit を作るかは AskUserQuestion(`--yes` では作らない)
- summary を出して exit 0

## Step 3 — `[BREAKING]` 検出と ADR 自動起票

```bash
git log --grep='\[BREAKING\]' --pretty=format:'%h %s' \
    "${PREV_MAIN_SHA}..${TARGET_SHA}" \
  > /tmp/deshi-breaking.txt

BREAKING_COUNT=$(wc -l < /tmp/deshi-breaking.txt | tr -d ' ')
```

`BREAKING_COUNT == 0` なら Step 4 へ。

`BREAKING_COUNT >= 1` の場合:

1. ADR 番号を採番:
   ```bash
   NEXT_ADR=$(printf "%04d" $(( $(ls .deshi/adr 2>/dev/null | wc -l) + 1 )))
   ADR_PATH=".deshi/adr/${NEXT_ADR}-upstream-${TARGET_SHA:0:7}-breaking.md"
   ```

2. ADR テンプレートを起票(skeleton のみ。Decision / Consequences は人間が後で埋める):

   ```markdown
   # ADR ${NEXT_ADR}: upstream ${TARGET_SHA:0:7} の BREAKING を取り込む

   - Status: proposed
   - Date: <YYYY-MM-DD>
   - Upstream range: ${PREV_MAIN_SHA}..${TARGET_SHA}
   - Target policy: ${TARGET_POLICY}
   - Detected commits:
     <git log --grep='[BREAKING]' の出力をここに貼る>

   ## Context
   <upstream で起きた BREAKING の概要。CHANGELOG へのリンク>

   ## Decision
   <a. 取り込む / b. 今回は skip する / c. patch を書く のどれを採ったか>

   ## Consequences
   <isbtty/nanoclaw 利用者への影響、必要な migration>
   ```

3. AskUserQuestion で 3 択:

   - **a. 取り込む** — upstream が migration skill を提示していれば紹介する。続けて Step 4 へ進み、merge 後に手動で migration を実行する前提。
   - **b. 今回は skip する** — sync branch を閉じてSkill を終了。`.deshi/upstream-versions.json` は更新しない。ADR は Status を `skipped` に書き換え、`.deshi/adr/${NEXT_ADR}-...md` のみを backup branch に commit。
   - **c. patch を書く** — ADR Status を `patch` にして commit。実際の patch 作業は別Skill / 別 PR(本Skill のスコープ外)。Step 4 にも進まずSkill を終了。

   `--yes` モードでの default は **a**。ただし ADR ファイルは物理的に残るため、人間レビュー無しで突き抜けることは無い。

## Step 4 — 現在の作業ブランチに merge

Step 0-1 で確認済み: 現在のブランチは `main` ではなく作業ブランチ (例: `feature/sync-upstream-<date>`)。本Skill は **既に居る作業ブランチに直接 merge する**。新しい sync branch は切らない (運用ポリシー: upstream 追従専用ブランチで作業し、最終的に main へ PR を出す前提)。

```bash
WORK_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Merging ${TARGET_SHA:0:7} into work branch: ${WORK_BRANCH}"
git merge --no-ff --no-commit "${TARGET_SHA}" || true
```

`--no-commit` で停止させ、衝突を Step 5 のポリシーで処理する。`merge` が clean exit でも commit は手で作る(metadata 更新と一緒の commit にまとめるため)。

merge 対象は `upstream/main` HEAD ではなく `${TARGET_SHA}` (default では共通祖先)。これにより、作業ブランチの HEAD は必ず channels の祖先になり、後段の channels skill が abort しない。

`src/channels/index.ts` で衝突したら、Step 0-2 で登録した `deshi-barrel` merge driver が自動的に union merge を実行するため、ここでは衝突マーカーが残らずに通過します(.gitattributes が読み込まれている場合)。

### 作業ブランチをまだ切っていない場合

Step 0-1 で「main 以外」が条件のため、本Skill 起動前に作業ブランチを準備しておく必要があります。一般的な手順:

```bash
git checkout main
git pull origin main
git checkout -b feature/sync-upstream-$(date +%Y%m%d)
# その後、本Skill (/deshi-update-from-upstream) を起動
```

## Step 5 — deshi 衝突解決ポリシーの機械適用

`git status --porcelain` を読み、衝突中ファイル(`UU` / `AA` / `DU` / `UD`)を以下の順で処理:

```
1. .deshi/**                     → git checkout --ours  -- <path>; git add <path>
2. src/deshi/**                  → git checkout --ours  -- <path>; git add <path>
3. CLAUDE.md, docs/**            → git checkout --theirs -- <path>; git add <path>
4. src/channels/<name>.ts        → git checkout --ours  -- <path>; git add <path>
   (index.ts は除外、Step 4 の merge driver で処理済みのはず)
5. src/channels/index.ts         → 通常は merge driver で解決済み。
   万一衝突が残っていた場合は手動 union merge にフォールバック:
       git merge-file --union -p \
           <(git show :2:src/channels/index.ts) \
           <(git show :1:src/channels/index.ts) \
           <(git show :3:src/channels/index.ts) \
           > src/channels/index.ts
       git add src/channels/index.ts
6. package.json                  → @chat-adapter/* 行のみ --ours、それ以外は手動マージ:
       (a) ours / theirs の両方を取り出して @chat-adapter/* 以外を手動 3-way merge
       (b) @chat-adapter/* は ours の値で固定
       (c) JSON が valid であることを確認
       git add package.json
7. それ以外(src/router.ts 等)  → 自動解決せず、未解決のまま残す
```

7 のファイルが残った場合は AskUserQuestion で:

- **resolve-now** — エディタ/手動で解決した上で続行(`--yes` では選べない)
- **abort** — `git merge --abort` してSkill 終了。backup branch / backup tag / sync branch は残る。

`--yes` モードで未解決ファイルが残った場合は **必ず abort** し、人間に手動継続を案内します(自動解決しないことが安全側)。

## Step 6 — Validation

```bash
# 1. lockfile 整合
pnpm install --frozen-lockfile

# 2. 型
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit

# 3. host build
pnpm run build

# 4. host tests
pnpm test

# 5. agent-runner tests
( cd container/agent-runner && bun install && bun test )
```

いずれかが失敗したら:

- AskUserQuestion: **retry-after-fix** / **abort**(`--yes` では abort)
- abort 時: `git merge --abort` 相当の状態に戻す案内を出す。**勝手に reset --hard はしない**。

## Step 7 — `.deshi/upstream-versions.json` を更新して commit

```bash
NOW_ISO=$(date +%Y-%m-%dT%H:%M:%S%z | sed 's/\(..\)$/:\1/')
USER_EMAIL=$(git config user.email)

# JSON を読み、upstream.main.* の sha / policy / lastSynced* を書き換える。
# upstream.main.tag は本Skill では使わないため touch しない (既存値があっても上書きしない)。
# upstream.channels はこのSkill では絶対に触らない。
TARGET_SHA="${TARGET_SHA}" TARGET_POLICY="${TARGET_POLICY}" \
NOW_ISO="${NOW_ISO}" USER_EMAIL="${USER_EMAIL}" \
node - <<'NODE'
const fs = require('fs');
const path = '.deshi/upstream-versions.json';
const j = JSON.parse(fs.readFileSync(path, 'utf8'));
j.schemaVersion = j.schemaVersion ?? 1;
j.upstream = j.upstream ?? {};
j.upstream.repo = 'nanocoai/nanoclaw';
j.upstream.main = j.upstream.main ?? {};
j.upstream.main.sha = process.env.TARGET_SHA;
j.upstream.main.policy = process.env.TARGET_POLICY; // "merge-base" | "target"
j.upstream.main.lastSyncedAt = process.env.NOW_ISO;
j.upstream.main.lastSyncedBy = process.env.USER_EMAIL;
j.provider = j.provider ?? { fixed: 'claude' };
fs.writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
NODE
```

commit を作る:

```bash
git add .deshi/upstream-versions.json
[ -n "${ADR_PATH:-}" ] && git add "${ADR_PATH}"

git commit -m "chore(deshi): sync upstream ${TARGET_SHA:0:7} (policy=${TARGET_POLICY})

- Range: ${PREV_MAIN_SHA}..${TARGET_SHA}
- Upstream main HEAD: ${UPSTREAM_MAIN_SHA}
- Upstream channels HEAD: ${UPSTREAM_CHANNELS_SHA}
- Merge-base: ${MERGE_BASE_SHA}
- Conflict policy: applied deshi default (.deshi/policies/conflict-resolution.json)
- Breaking commits: ${BREAKING_COUNT}
- ADR: ${ADR_PATH:-none}
"
```

## Step 8 — `/deshi-update-nanoclaw-official-channels update` の自動連鎖呼出

```
invoke-skill: /deshi-update-nanoclaw-official-channels update
```

このSkill が:

- 失敗した場合は warn を出して continue(本Skill 全体は止めない)
- 成功した場合は `.deshi/upstream-versions.json` の `upstream.channels.*` がそちらで更新される(本Skill では触らない)

連鎖実行後は再度 `pnpm install --frozen-lockfile` と `pnpm exec tsc --noEmit` 程度の軽い再検証を回すことを推奨。

## Step 9 — deshi tag の bump 提案

```bash
SUGGESTED_TAG=$(node - <<'NODE'
const cur = process.env.CURRENT_DESHI_TAG || 'v0.0.0';
const m = cur.match(/^v(\d+)\.(\d+)\.(\d+)$/);
if (!m) { console.log(cur); process.exit(0); }
console.log(`v${m[1]}.${m[2]}.${Number(m[3]) + 1}`);
NODE
)
```

AskUserQuestion で `${SUGGESTED_TAG}` を提示(`--yes` モードでは default 採用):

- **accept** — 提示通り
- **edit** — minor / major bump を選び直す
- **skip** — tag を打たない(metadata の `deshi.*` も更新しない)

`accept` / `edit` を選んだら annotated tag を作成し、`.deshi/upstream-versions.json` の `deshi.currentTag` / `deshi.currentCommit` を更新する commit を amend で含める。

`--yes` モードであっても **tag の push は本Skill は行わない**。`git push origin ${WORK_BRANCH}` と `git push origin ${CHOSEN_TAG}` は人間が PR レビュー後に明示的に実行します。

## Step 10 — Summary を印字

```
========================================
 deshi-update-from-upstream — summary
========================================
Work branch         : ${WORK_BRANCH}
Backup branch       : ${BACKUP_BRANCH}
Backup tag          : ${BACKUP_TAG}

Upstream main HEAD  : ${UPSTREAM_MAIN_SHA:0:7}
Upstream channels   : ${UPSTREAM_CHANNELS_SHA:0:7}
Merge-base          : ${MERGE_BASE_SHA:0:7}
Target taken        : ${TARGET_SHA:0:7}  [policy=${TARGET_POLICY}]
Range               : ${PREV_MAIN_SHA:0:7}..${TARGET_SHA:0:7}
Breaking count      : ${BREAKING_COUNT}
ADR                 : ${ADR_PATH:-none}

deshi tag       : ${CURRENT_DESHI_TAG} → ${CHOSEN_TAG:-skipped}

Channel re-apply: ${CHANNEL_RESULT:-skipped}   (warn-only, see logs above)

Next actions (human):
  1. Review the diff:           git diff main..${WORK_BRANCH}
  2. Open a PR:                 gh pr create --base main --head ${WORK_BRANCH}
  3. After merge, push tag:     git push origin ${CHOSEN_TAG:-<none>}
========================================
```

## Notes

このSkill 自身は **`main` を直接更新しない / push しない** ため、cron で回しても master の状態を破壊することはありません。`--yes` モードで動いた結果は、ADR が起票されていれば人間レビュー依頼、validation 失敗なら作業ブランチを残したまま停止して人間に渡します。

## 関連 Skill

| Skill | 関係 |
|---|---|
| upstream `/update-nanoclaw` | 本Skill のベース。fetch / preview / merge / validate の骨組みを継承 |
| `/deshi-update-nanoclaw-official-channels` | 本Skill の Step 8 で自動呼出。channel branch の再適用と `upstream.channels.*` の更新を担当 |
