# `deshi-barrel` merge driver のローカルセットアップ

`isbtty/nanoclaw` を clone した直後に、開発者は **一度だけ** ローカル git config に
custom merge driver `deshi-barrel` を登録する必要があります。

## なぜ必要か

`.gitattributes` で `src/channels/index.ts` と `src/providers/index.ts` に
`merge=deshi-barrel` を割り当てています。これは upstream 追従時の barrel 衝突を
自動 union merge で解決するためのものです (詳細は ADR-0005)。

git のセキュリティモデル上、merge driver の本体 (`.deshi/scripts/merge-barrel.sh`)
を `.gitattributes` から自動でローカル設定に登録することはできません。各開発者が
明示的に登録するか、`/deshi-update-from-upstream` skill が初回実行時に自動登録する
かのいずれかが必要です。

## 手動セットアップ

リポジトリのルートで次を実行:

```bash
git config merge.deshi-barrel.name "deshi barrel union merge driver"
git config merge.deshi-barrel.driver ".deshi/scripts/merge-barrel.sh %O %A %B %P"
```

これでローカルの `.git/config` に `[merge "deshi-barrel"]` セクションが追記され、
`.gitattributes` の宣言と紐づきます。

## 確認

```bash
git config --get merge.deshi-barrel.driver
# 出力例: .deshi/scripts/merge-barrel.sh %O %A %B %P
```

## 自動セットアップ

`/deshi-update-from-upstream` skill は Step 0-2 で未登録なら自動的に上記コマンドを
実行します。skill 起動時にセットアップを忘れていても自動で復旧するため、`skill を
1 回でも走らせれば登録は完了する` 設計です。

## 未登録のまま走らせるとどうなるか

`src/channels/index.ts` 等で衝突が起きた際に union merge が走らず、`<<<<<<<` 衝突
マーカーが残ったまま停止します。skill 内のフォールバックロジック
(`git merge-file --union` 直接呼び出し) で解決される設計ですが、登録しておく方が
ログがクリーンになります。

## 関連

- ADR-0005: `barrel 衝突は merge driver + src/deshi/index.ts パターンで解決する`
- `.gitattributes`: `merge=deshi-barrel` の割り当て
- `.deshi/scripts/merge-barrel.sh`: driver 本体
