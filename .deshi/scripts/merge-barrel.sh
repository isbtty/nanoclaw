#!/usr/bin/env bash
#
# merge-barrel.sh — git custom merge driver for deshi barrel files
#
# ADR-0005: barrel 衝突対策。
# upstream の barrel ファイル (src/channels/index.ts, src/providers/index.ts) は
# 新しい channel/provider が追加されるたびに `import './<name>.js';` 行が増える。
# deshi も同じファイルに `import './deshi.js';` を1行追加するため、ここで衝突しがち。
#
# このスクリプトは git の custom merge driver として登録され、衝突発生時に
# `git merge-file --union` を呼んで両側の import 行を全て残し、重複排除する。
#
# 登録方法 (各開発者の ~/.gitconfig に追記、または `git config` で設定):
#   git config merge.deshi-barrel.name "deshi barrel union merge driver"
#   git config merge.deshi-barrel.driver ".deshi/scripts/merge-barrel.sh %O %A %B %P"
#
# .gitattributes 側で対象ファイルにこの driver を割り当てる:
#   src/channels/index.ts   merge=deshi-barrel
#   src/providers/index.ts  merge=deshi-barrel
#
# 引数 (git が自動で渡す):
#   $1 = %O = ancestor のテンポラリファイル
#   $2 = %A = ours のテンポラリファイル (この内容を最終結果で上書きする)
#   $3 = %B = theirs のテンポラリファイル
#   $4 = %P = 対象ファイルのリポジトリ内パス (ログ用)
#
# 終了コード:
#   0 = 成功 (衝突なくマージ完了)
#   1 = 失敗 (git に衝突として扱わせ、人間判断に委ねる)

set -euo pipefail

ANCESTOR="$1"
OURS="$2"
THEIRS="$3"
PATH_HINT="${4:-<unknown>}"

# git merge-file は in-place で OURS を書き換える。
# --union オプションで両側の差分行を全て残す。
# 重複行の除去は git merge-file 自体は行わないため、後段で手動 dedupe する。

if git merge-file --union -L ours -L ancestor -L theirs "$OURS" "$ANCESTOR" "$THEIRS"; then
  # union merge 成功後、import 行の重複を除去する。
  # 順序は維持しつつ (awk による in-order dedupe)、import 文以外の行はそのまま残す。
  TMP="$(mktemp)"
  awk '
    /^import .+;$/ {
      if (!(seen[$0]++)) print
      next
    }
    { print }
  ' "$OURS" > "$TMP"
  mv "$TMP" "$OURS"
  exit 0
else
  echo "merge-barrel.sh: union merge failed for $PATH_HINT" >&2
  exit 1
fi
