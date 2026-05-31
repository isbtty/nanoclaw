# ADR 0014: upstream 3601a8a の BREAKING を取り込む

- Status: proposed
- Date: 2026-05-31
- Upstream range: 7e37b13aabd0d7ed8ebdedfa96cecad8e1e89796..3601a8a (upstream/main HEAD)
- Target policy: target (--target upstream/main)
- Detected commits:
  - `5b14ae2 docs: add v2.0.63 CHANGELOG entry and RELEASING.md`
    - 本 commit 自体は CHANGELOG ロールアップだが、その内容に `[BREAKING]` が含まれる

## Context

upstream nanocoai/nanoclaw v2.0.55..v2.0.63 のロールアップで以下の BREAKING change が CHANGELOG に明示されている:

- **Service names are now per-install.** v2 install では launchd label と systemd unit が project root の slug 付きに変更された:
  - macOS: `com.nanoclaw` → `com.nanoclaw.<sha1(projectRoot)[:8]>`
  - Linux: `nanoclaw.service` → `nanoclaw-<slug>.service`
  - 古い `com.nanoclaw` / `nanoclaw.service` 名はもう実サービスにマッチしない。
  - 自分の install の名前を見るには:
    - macOS: `source setup/lib/install-slug.sh && launchd_label`
    - Linux: `source setup/lib/install-slug.sh && systemd_unit`
  - `ncl` の transport-error help text や 26 個の skill ファイルが canonical helper-driven pattern に変更されている。
  - See [setup/lib/install-slug.sh](../../setup/lib/install-slug.sh).

加えて同じ範囲 (544 commits) には以下も含まれる(非 BREAKING だがレビューが必要):
- claude-code / claude-agent-sdk のバージョン bump 多数
- 各種 fix と機能追加 (whatsapp formatting skill, drop messages envelope, transcript rotate-age 等)
- バージョンは 2.0.55 → 2.0.71 までジャンプ

## Decision

<a. 取り込む / b. 今回は skip する / c. patch を書く のどれを採ったか>

(後で記入)

## Consequences

deshi 利用者(本フォーク利用者)への影響:

- 既存 install のサービス名は今回の取込みで自動的に slug 化される**わけではない** (新規 install からの挙動変更)。
- ただし、launchd plist / systemd unit を再生成すると古い名前のサービスとぶつかる可能性がある。
- 取込み後、deshi install 上で `launchd_label` / `systemd_unit` を実行して、現在のサービス名を確認すること。
- README / docs の copy-paste 用 restart コマンドが古い名前のままなら更新が必要。
- skill ファイル群 (26 個) が canonical helper pattern に変わるため、deshi 側でこれらを上書きしていれば衝突する可能性。
