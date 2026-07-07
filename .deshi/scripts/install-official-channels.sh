#!/usr/bin/env bash
#
# install-official-channels.sh
#
# upstream/channels から、.deshi/upstream-versions.json の
# upstream.channels.installed 配列に列挙された channel を取り込む。
#
# 取り込む内容:
#   1. src/channels/<name>.ts および関連ファイル (<name>-*.ts, <name>.test.ts)
#   2. setup/install-<name>.sh (存在する場合)
#   3. setup/channels/<name>.ts (存在する場合)
#   4. .claude/skills/add-<name>/ ディレクトリ全体 (存在する場合)
#   5. package.json の dependencies / devDependencies に upstream/channels と
#      base (= upstream-versions.json の upstream.main.sha) の差分を追加
#
# このスクリプトは pnpm install までは行わない (lockfile への影響を最小化するため、
# 呼び出し側で `pnpm install` を実行する責務を持つ)。
#
# /deshi-update-nanoclaw-official-channels skill から呼ばれる前提だが、単独実行も可。
#
# 環境変数:
#   DESHI_CHANNELS_REF — 取り込み元の git ref (未指定時は upstream/channels HEAD)
#                        reinstall モードで .deshi/upstream-versions.json の sha を使う際に指定。
#
# 引数:
#   --dry-run        — 何をするかだけ表示し、ファイルを書き換えない
#   --base-ref <ref> — 差分抽出の基準 ref (未指定時は upstream-versions.json の upstream.main.sha)
#
# 終了コード:
#   0 = 成功
#   1 = 整合性チェック失敗 / 致命エラー
#   2 = 引数エラー

set -euo pipefail

# ---------- パラメータ ----------
DRY_RUN=0
BASE_REF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --base-ref) BASE_REF="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

CHANNELS_REF="${DESHI_CHANNELS_REF:-upstream/channels}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSIONS_FILE="$REPO_ROOT/.deshi/upstream-versions.json"

# ---------- 整合性チェック ----------
if [[ ! -f "$VERSIONS_FILE" ]]; then
  echo "ERROR: $VERSIONS_FILE not found" >&2
  exit 1
fi

# upstream/channels が fetch 済みか確認
if ! git rev-parse --verify "$CHANNELS_REF" >/dev/null 2>&1; then
  echo "ERROR: ref $CHANNELS_REF not found. Run: git fetch upstream channels" >&2
  exit 1
fi

# base ref の決定
# 既定では upstream-versions.json の upstream.main.sha を使う。
# isbtty/nanoclaw は ADR-0008 に基づき main HEAD ではなく
# merge-base(upstream/main, upstream/channels) を upstream.main.sha に書き込む運用。
# よって本スクリプトの BASE_REF も自動的に共通祖先になり、channels との差分計算が
# 「共通祖先 → channels HEAD」= channels 固有の変更のみ、になる。
# `/deshi-update-from-upstream` を先に走らせて upstream.main.sha が共通祖先を指していることが前提。
if [[ -z "$BASE_REF" ]]; then
  BASE_REF="$(python3 -c "import json; print(json.load(open('$VERSIONS_FILE'))['upstream']['main']['sha'])")"
fi
if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "ERROR: base ref $BASE_REF not found" >&2
  exit 1
fi

# installed 配列を取得
mapfile -t CHANNELS < <(python3 -c "import json; [print(c) for c in json.load(open('$VERSIONS_FILE'))['upstream']['channels']['installed']]")

if [[ ${#CHANNELS[@]} -eq 0 ]]; then
  echo "ERROR: upstream.channels.installed is empty in $VERSIONS_FILE" >&2
  exit 1
fi

# ---------- deshi: barrel 非 active channel ----------
# installed[] に入っていて source は同期するが、src/channels/index.ts の barrel では
# import を有効化しない channel。upstream の <ch>-registration.test.ts は「barrel を
# 読んで当該 channel が登録済みか」を検証するため、barrel 非 active な channel の
# registration test を取り込むと必ず red になる。そこでここに列挙した channel の
# "-registration.test.ts" だけコピー対象から除外する (本体 .ts は同期する)。
#
#   matrix — @beeper/chat-adapter-matrix@0.2.0 が matrix-js-sdk の内部モジュールを
#            拡張子なし ESM import で参照しており import 時にクラッシュする。barrel で
#            有効化すると host boot / 全 barrel test を道連れに落とすため無効化必須。
#            upstream 側で adapter が修正されたら barrel を active 化し、この行を外す。
DESHI_BARREL_DISABLED=("matrix")

deshi_is_barrel_disabled() {
  local target="$1" c
  for c in "${DESHI_BARREL_DISABLED[@]}"; do
    [[ "$c" == "$target" ]] && return 0
  done
  return 1
}

echo "==> install-official-channels.sh"
echo "    channels ref : $CHANNELS_REF ($(git rev-parse --short "$CHANNELS_REF"))"
echo "    base ref     : $BASE_REF ($(git rev-parse --short "$BASE_REF"))"
echo "    installed    : ${#CHANNELS[@]} channels — ${CHANNELS[*]}"
echo "    dry-run      : $DRY_RUN"
echo

# ---------- ファイル取り込みヘルパー ----------
# git show <ref>:<path> > <dest>。ref に <path> が無ければ no-op。
copy_if_exists() {
  local ref="$1" path="$2"
  if git cat-file -e "$ref:$path" 2>/dev/null; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  [dry-run] copy: $path"
    else
      mkdir -p "$(dirname "$REPO_ROOT/$path")"
      git show "$ref:$path" > "$REPO_ROOT/$path"
      echo "  copied: $path"
    fi
    return 0
  fi
  return 1
}

# ディレクトリ全体を ref から取り込む。
# git ls-tree -r で配下の全ファイルを列挙してそれぞれ copy_if_exists を呼ぶ。
copy_dir_if_exists() {
  local ref="$1" dir="$2"
  local files
  if ! files="$(git ls-tree -r --name-only "$ref" -- "$dir" 2>/dev/null)" || [[ -z "$files" ]]; then
    return 1
  fi
  while IFS= read -r f; do
    copy_if_exists "$ref" "$f"
  done <<< "$files"
  return 0
}

# ---------- channel ごとの取り込み ----------
declare -i imported_count=0

for ch in "${CHANNELS[@]}"; do
  echo "==> channel: $ch"
  ch_imported=0

  # 1. src/channels/<name>*.ts (本体 + ヘルパー + テスト)
  #    マッチ対象は "<ch>.ts" と "<ch>.test.ts" と "<ch>-<word>..." (ヘルパー / pairing 等)。
  #    ただし installed 配列内の他 channel 名 (例: "whatsapp-cloud") と完全一致する基底名
  #    は除外する (whatsapp の処理で whatsapp-cloud.ts を拾わないため)。
  src_files="$(git ls-tree -r --name-only "$CHANNELS_REF" -- "src/channels/" 2>/dev/null \
    | awk -v ch="$ch" -v others="${CHANNELS[*]}" '
        BEGIN {
          n = split(others, arr, " ")
        }
        function basename_of(path,    parts, m) {
          m = split(path, parts, "/")
          return parts[m]
        }
        function strip_suffix(name) {
          sub(/\.test\.ts$/, "", name)
          sub(/\.ts$/, "", name)
          return name
        }
        {
          base = strip_suffix(basename_of($0))
          # 他 channel と完全一致する基底名は無条件で skip
          for (i = 1; i <= n; i++) {
            if (arr[i] != ch && base == arr[i]) next
          }
          # "<ch>.ts" or "<ch>.test.ts"
          if ($0 ~ "^src/channels/"ch"\\.(ts|test\\.ts)$") { print; next }
          # "<ch>-<rest>"
          if ($0 ~ "^src/channels/"ch"-[a-z]") { print }
        }
      ')"
  if [[ -n "$src_files" ]]; then
    while IFS= read -r f; do
      # deshi: barrel 非 active channel の registration test はコピーしない
      # (barrel を読んで登録済みを assert するため、非 active だと必ず red になる)。
      if [[ "$f" == *-registration.test.ts ]] && deshi_is_barrel_disabled "$ch"; then
        [[ $DRY_RUN -eq 1 ]] && echo "  [dry-run] skip (barrel-disabled reg test): $f" \
                             || echo "  skip (barrel-disabled reg test): $f"
        continue
      fi
      copy_if_exists "$CHANNELS_REF" "$f" && ch_imported=1
    done <<< "$src_files"
  fi

  # 2. setup/install-<name>.sh
  copy_if_exists "$CHANNELS_REF" "setup/install-$ch.sh" && ch_imported=1 || true

  # 3. setup/channels/<name>.ts
  copy_if_exists "$CHANNELS_REF" "setup/channels/$ch.ts" && ch_imported=1 || true

  # 4. .claude/skills/add-<name>/ ディレクトリ全体
  copy_dir_if_exists "$CHANNELS_REF" ".claude/skills/add-$ch" && ch_imported=1 || true

  if [[ $ch_imported -eq 0 ]]; then
    echo "  WARN: no files found for channel '$ch' in $CHANNELS_REF"
  else
    imported_count+=1
  fi
done

echo
echo "==> imported channels: $imported_count / ${#CHANNELS[@]}"

# ---------- src/channels/index.ts の再構築 ----------
# upstream/channels 側の index.ts を取り込む (各 channel の import 行を含む)。
# ただし、後で .gitattributes の deshi-barrel merge driver が deshi.js の import を
# 加える前提なので、ここでは「upstream/channels 側の index.ts そのまま」で OK。
echo
echo "==> updating src/channels/index.ts from $CHANNELS_REF"
copy_if_exists "$CHANNELS_REF" "src/channels/index.ts" || echo "  WARN: src/channels/index.ts not found in $CHANNELS_REF"

# ---------- package.json の依存追加 ----------
echo
echo "==> updating package.json dependencies (diff: $BASE_REF → $CHANNELS_REF)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  python3 <<PYEOF
import subprocess, json
ch = json.loads(subprocess.check_output(['git', 'show', '$CHANNELS_REF:package.json']))
mn = json.loads(subprocess.check_output(['git', 'show', '$BASE_REF:package.json']))
ch_deps = {**ch.get('dependencies', {}), **ch.get('devDependencies', {})}
mn_deps = {**mn.get('dependencies', {}), **mn.get('devDependencies', {})}
diff = {k: v for k, v in ch_deps.items() if k not in mn_deps}
print(f"  [dry-run] would add {len(diff)} dependencies:")
for k, v in sorted(diff.items()):
    print(f"    {k} = {v}")
PYEOF
else
  python3 <<PYEOF
import subprocess, json
ch = json.loads(subprocess.check_output(['git', 'show', '$CHANNELS_REF:package.json']))
mn = json.loads(subprocess.check_output(['git', 'show', '$BASE_REF:package.json']))
ch_deps = {**ch.get('dependencies', {}), **ch.get('devDependencies', {})}
mn_deps = {**mn.get('dependencies', {}), **mn.get('devDependencies', {})}
diff = {k: v for k, v in ch_deps.items() if k not in mn_deps}

with open('$REPO_ROOT/package.json', 'r') as f:
    pkg = json.load(f)

pkg.setdefault('dependencies', {})
ch_dep_keys = set(ch.get('dependencies', {}).keys())
ch_devdep_keys = set(ch.get('devDependencies', {}).keys())

added = 0
for k, v in diff.items():
    target_section = 'devDependencies' if k in ch_devdep_keys and k not in ch_dep_keys else 'dependencies'
    pkg.setdefault(target_section, {})
    if k not in pkg[target_section]:
        pkg[target_section][k] = v
        print(f"  added [{target_section}]: {k} = {v}")
        added += 1
    else:
        print(f"  skip (already present): {k}")

# JSON はインデント 2、末尾改行ありで書き戻す
with open('$REPO_ROOT/package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')

print(f"==> added {added} new dependencies to package.json")
PYEOF
fi

echo
echo "==> done. Next steps:"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  (dry-run) — no files written. Re-run without --dry-run to apply."
else
  echo "  1. Review: git status / git diff"
  echo "  2. Run:    pnpm install"
  echo "  3. Verify: pnpm run build && pnpm test"
fi
