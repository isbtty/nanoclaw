# ADR-0018: Slack マルチワークスペース対応 — deshi 側 instance 登録で実現

- Status: accepted (実装待ち)
- Date: 2026-07-13
- Refs: isbtty/deshi#560

## Context

nanoclaw を複数の独立した Slack ワークスペース(例: 自社 + クライアント社)に同時常駐させたい。

コア側の調査結果:

- レジストリ・DB・ルーター・配信は **instance 次元に完全対応済み**。
  - `channel-registry.ts`: `activeAdapters` は `adapter.instance ?? adapter.channelType` でキー分け。配信/typing は `getChannelAdapterExact()` で厳密一致(別 bot への誤爆なし)。
  - `messaging_groups.instance` + `UNIQUE(channel_type, platform_id, instance)` (migration 016)。inbound は host 側で `instance` をスタンプ (`src/index.ts` onInbound)。
  - `chat-sdk-bridge.ts`: `config.instance` が registry キー / webhook route (`/webhook/<instance>`) / Chat SDK SQLite state namespace を分離する。URL-safe (`[A-Za-z0-9._-]+`) 検証あり。
- 一方 upstream の `src/channels/slack.ts` は固定 env 名 (`SLACK_BOT_TOKEN` 等) を 1 組だけ読む単一インスタンス登録。`/add-slack` スキルも upstream にもマルチワークスペースの導線はない。

つまり不足しているのは「2 つ目以降の登録コード」だけ。ただし `src/channels/slack.ts` は upstream 管理ファイルであり、直接改修すると `/deshi-update-from-upstream` / チャンネル再インストールで上書き・衝突する (ADR-0002, ADR-0005)。

## Decision

**upstream の `slack.ts` には触れず、`src/deshi/channels/slack-instances.ts` を新設**し、env 宣言だけで N ワークスペースを追加登録できるようにする。

### 1. 配置 (ADR-0002 namespace 準拠)

```
src/deshi/channels/slack-instances.ts       # 本体 (self-registration)
src/deshi/channels/slack-instances.test.ts  # vitest
src/deshi/channels/index.ts                 # import './slack-instances.js'; を 1 行追加
```

既存のプライマリワークスペースは upstream `slack.ts` のデフォルトインスタンス (`instance = 'slack'`) のまま **無変更・無移行**。

### 2. env 規約

```bash
# 追加ワークスペースのサフィックス一覧 (明示宣言。カンマ区切り、A-Z0-9_ のみ)
DESHI_SLACK_WORKSPACES=ACME,CLIENT_B

# サフィックスごとの credential (upstream の SLACK_* 命名を踏襲)
SLACK_BOT_TOKEN_ACME=xoxb-...
SLACK_APP_TOKEN_ACME=xapp-...        # Socket Mode 推奨
SLACK_SIGNING_SECRET_ACME=...        # webhook モード時のみ必須
```

- 制御変数は deshi 固有なので `DESHI_` prefix (ADR-0001, `DESHI_HOST_TOOLS_BIND` 前例)。token 変数は upstream の `SLACK_BOT_TOKEN` 命名との対称性を優先し `SLACK_*_<SUFFIX>`。
- **明示リスト方式**を採用 (env スキャンでの自動発見は不採用 — typo が幽霊インスタンスを生む。明示リストなら token 未設定時に registry が `Channel credentials missing, skipping { channel: 'slack-acme' }` と出て気づける)。

### 3. instance 命名

- registration name = instance name = `slack-<suffix を小文字化し _ → - 変換>` (例: `ACME` → `slack-acme`, `CLIENT_B` → `slack-client-b`)。
- `channelType` は **`'slack'` のまま**(Chat SDK adapter が設定)。user-id スキーム (`slack:<id>`)、フォーマット skill、container config は全ワークスペースで共有される — これは意図した挙動。

### 4. factory は upstream `slack.ts` のミラー

各インスタンスの factory は upstream factory と同じ組み立てを行う:
`createSlackAdapter` → `createChatSdkBridge({ instance, supportsThreads, concurrency: 'concurrent', enrichInboundText: permalink 解決 })` → `resolveChannelName` / `fetchThreadBackfill` 装着。

`slack-permalink.js` / `chat-sdk-bridge.js` は import して再利用する(コピーしない)。ミラーするのは factory 本体 約 40 行のみ。

**ドリフト対策**: ファイルヘッダに「`src/channels/slack.ts` のミラー。upstream 更新時に差分確認すること」を明記し、`/deshi-update-from-upstream` スキルのチェックリストに「`src/channels/slack.ts` に diff があれば `slack-instances.ts` へ反映確認」を 1 項目追加する。

### 5. 実装スケッチ (handoff 用)

```typescript
// src/deshi/channels/slack-instances.ts
// deshi 固有: 追加 Slack ワークスペースの instance 登録。
// factory は src/channels/slack.ts のミラー — upstream 更新時に差分確認すること。

export function parseWorkspaceSuffixes(raw: string | undefined): string[] {
  // カンマ区切り → trim → /^[A-Z0-9_]+$/ 検証 (不正は log.warn + skip) → 重複除去
}

export function instanceNameFor(suffix: string): string {
  return 'slack-' + suffix.toLowerCase().replace(/_/g, '-');
}

// import 時 (registration は同期、credential 読みは factory 内で遅延):
const suffixes = parseWorkspaceSuffixes(readEnvFile(['DESHI_SLACK_WORKSPACES']).DESHI_SLACK_WORKSPACES);
for (const suffix of suffixes) {
  const instance = instanceNameFor(suffix);
  registerChannelAdapter(instance, {
    factory: () => {
      const env = readEnvFile([
        `SLACK_BOT_TOKEN_${suffix}`, `SLACK_SIGNING_SECRET_${suffix}`, `SLACK_APP_TOKEN_${suffix}`,
      ]);
      const botToken = env[`SLACK_BOT_TOKEN_${suffix}`];
      if (!botToken) return null;
      // …以降 upstream slack.ts の factory と同一 (createSlackAdapter → bridge に
      // instance を渡す → resolveChannelName / fetchThreadBackfill / permalink enrich)。
      // log.warn には { instance } を含める。
    },
  });
}
```

テスト: `parseWorkspaceSuffixes` / `instanceNameFor` を pure 関数として export し unit test。import 時副作用は薄く保つ。

### 6. 運用フロー (ワークスペース追加 1 件あたり)

1. 対象ワークスペースに Slack App を新規作成 (プライマリと同じ manifest 構成。Socket Mode 有効化)。**注**: 同一 App をマルチワークスペース配布しても bot token はワークスペースごとに別発行 (xoxb) なので、いずれにせよ 1 workspace = 1 token = 1 instance。
2. `.env` に `DESHI_SLACK_WORKSPACES` へサフィックス追記 + `SLACK_BOT_TOKEN_<S>` / `SLACK_APP_TOKEN_<S>` 追加。
3. host 再起動 (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`)。
4. bot をチャンネル招待 or DM → 初回 inbound で `messaging_groups` に `instance = slack-<s>` の行が自動作成される。
5. `ncl wirings create` で agent group へ配線 (既存フローと同一。`/manage-channels` 使用可)。

## Consequences

- env 追記 + 再起動だけでワークスペースを増減できる。コア(upstream 管理ファイル)への diff はゼロ。
- webhook route は instance ごとに `/webhook/slack-acme` が自動で立つ (webhook モードを選ぶ場合は Slack App の Event Subscriptions をそこへ向ける)。Socket Mode なら公開エンドポイント不要。
- Chat SDK の state namespace は named instance で自動分離 — 2 App 間の state 衝突なし。

### 既知の制約 (受容する)

1. **cold DM / 承認配送のフォールバックはプライマリ固定**: `getChannelAdapter('slack')` の channelType フォールバックは最初に登録された adapter (= upstream デフォルト instance) に解決される。一度でも bot に DM した user は `user_dms` → messaging_group 経由で正しい instance から届く (warm path は instance-aware)。→ 追加ワークスペース側の admin/approver には初回に bot へ 1 通 DM してもらう運用にする。
2. **user-id のワークスペース間衝突は理論上あり得る**: user は `slack:<U-id>` で instance 非依存。Slack の U-id は workspace スコープだが実質衝突しない前提を受容。role 付与 (`ncl roles grant`) は全ワークスペース横断で効く点に注意。
3. **クロスワークスペースの permalink 解決は不可**: 各 instance は自分の token で読める permalink のみ解決。他方のリンクは warn ログ + 素通し (既存のフェイルソフト挙動)。
4. **factory ミラーのドリフトリスク**: `slack-instances.ts` の factory は `src/channels/slack.ts` の factory を手でミラーしたもの。upstream が `slack.ts` の inbound 加工 (permalink enrichment / thread backfill / bridge 構築) を変更しても本ファイルは自動追随しない。緩和策は二段構え: (a) ファイルヘッダに「`src/channels/slack.ts` のミラー。upstream 更新時に差分確認すること」を明記、(b) `/deshi-update-from-upstream` の Operating principles に「取込 range で `src/channels/slack.ts` が touch されていたら `slack-instances.ts` への反映要否を人間が確認する」チェック項目を追加。それでも取りこぼしはあり得るため、Slack 挙動が追加ワークスペースだけで劣化した場合は真っ先にこのドリフトを疑う。将来 upstream に `SLACK_INSTANCES` 的な汎用対応を PR できたら本ファイルは廃止して移行する。
5. **サフィックスは実質不変の永続識別子**: サフィックスは instance 名 (`slack-<suffix>` = registry key = webhook route = Chat SDK state namespace) を決定する。既にワークスペースを運用開始した後でサフィックスを改名すると instance キーが変わり、既存の `messaging_groups` 行 (`UNIQUE(channel_type, platform_id, instance)`) と Chat SDK state namespace が orphan 化する — チャンネルは別 instance の新規グループとして再作成され、既存 wiring も失われる。改名は移行ではなく別インスタンス新設として扱われるため、サフィックスは作成時に慎重に命名し、以後は変更しない (token 変数名 `SLACK_*_<SUFFIX>` も連動して張り替えが必要になる点に注意)。

## 不採用案

- **(a) upstream `slack.ts` を直接ループ化改修**: `/add-slack` 再インストール・upstream 更新で上書きされる。ADR-0002 違反。
- **(b) instance 設定を central DB (container_configs 類似) に置く**: channel credential は全チャンネルで `.env` 読みが確立済み。DB 化は過剰設計で、boot 時 registration (同期 import) とも相性が悪い。
- **(c) env prefix スキャンによる自動発見** (`SLACK_BOT_TOKEN_*` を走査): 宣言なしで増える利便性より、typo・stray env による幽霊インスタンスのリスクと可観測性の低下が勝る。

## See also

- namespace 規約: ADR-0002 / barrel 1 行ルール: ADR-0005
- コア instance 機構: `src/channels/channel-registry.ts`, `src/channels/chat-sdk-bridge.ts` (instance 検証・state namespace), `src/db/messaging-groups-instance.test.ts`
- ミラー元: `src/channels/slack.ts`
