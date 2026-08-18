# ADR-0019: deshi 所有テーブルの作り方と `ensureUserDm` への直接侵襲

- Status: accepted
- Date: 2026-08-07
- Refs: isbtty/boswell#712, isbtty/deshi#517

## Context

承認カードの共有チャンネル配線（deshi#517）は `user_dms` の行を書き換えるスナップショット
方式だった。配線後に付与した admin には適用されず、その人が先頭 approver になった時点で
カードが個人 DM に出て埋もれる事故が起きた（boswell#712）。

これを「配信時に `user_roles` を引き直すライブなルール」に置き換えるにあたり、ADR-0002
（deshi 固有コードは `src/deshi/**` に閉じる）に対する 2 つの逸脱が必要になった。

1. deshi 所有の設定テーブルが要る。しかし `src/db/migrations/` は upstream 管理ディレクトリで、
   ここに deshi 用 migration を足すと `/boswell-update-from-upstream` の恒常的な衝突点になる。
2. 振り替えは `ensureUserDm()` の挙動そのものを差し替える必要がある。ADR-0002 が原則とする
   「upstream ファイルへは `import './deshi.js';` の 1 行のみ」では実現できない。

## Decision

### 1. deshi 所有テーブルは `deshi_` prefix + `CREATE TABLE IF NOT EXISTS`

- テーブル名に `deshi_` prefix を必須とする（ADR-0001 の命名規約をテーブルにも適用）。
- upstream の migration registry には登録しない。`src/deshi/**` 側に冪等な `ensureSchema()`
  を置き、読み書きの各エントリポイント冒頭で呼ぶ。
- FK 制約は張らない（migration 外で作るため）。参照先の生存は読み出し時に検証する。
- 初例: `deshi_approvals_channel`（`src/deshi/approvals-channel/db.ts`）。

### 2. `ensureUserDm` への直接侵襲を ADR-0002 の明示的な例外とする

`src/modules/permissions/user-dm.ts` に import 1 行 + 呼び出し 3 行を許す。

```ts
const override = resolveApprovalsChannelOverride(userId, channelType);
if (override) return override;
```

未配線なら `null` を返して upstream の通常解決にフォールバックするため、既定インストールでは
完全な no-op。

**レジストリ方式（`registerUserDmResolver()` を upstream に足す）を採らない理由**: 登録は
`src/deshi/**` の副作用 import に依存するため、`ensureUserDm` が起動直後に呼ばれる経路では
登録順序を保証できない。直接 import なら順序に依存しない。行数の多寡ではなくこれが理由。

挿入位置は `parseUserId` の直後とする。Teams のように id が `29:` 始まりで channel_type が
`user.kind` 由来になるケースの分岐を deshi 側に再実装しないため（upstream が解決済みの
`channelType` を受け取る）。

## Consequences

- deshi 所有テーブルは `/boswell-update-from-upstream` の衝突対象にならない。一方 upstream が
  同名テーブルを作った場合は衝突するので、`deshi_` prefix が実質的な予約になる。
- `user-dm.ts` は upstream 追従時の要注意ファイルになる。ただし `ensureUserDm` の関数冒頭は
  upstream でも安定しており、衝突面積は 4 行。
- verify-layout.ts（ADR-0007、未実装）を実装する際は、この 1 ファイルを ADR-0002 の
  allowlist に入れること。

## See also

- 実装: `src/deshi/approvals-channel/{db,resolve-override,wire}.ts`
- 侵襲箇所: `src/modules/permissions/user-dm.ts`
- 設計: isbtty/boswell#712
