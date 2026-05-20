# ADR-0011: 外部システムからの通知を `messages_in` へ注入して会話継続性を保つ

- Status: accepted
- Date: 2026-05-20
- Refs: isbtty/deshi#248, isbtty/deshi#247, isbtty/nanoclaw#6

## Context

ADR-0010 と [isbtty/nanoclaw#6](https://github.com/isbtty/nanoclaw/pull/6) で、deshi daemon から nanoclaw への通知 push 経路 `POST /inbound/deshi/skill-execution-notifications` を新設した。当初の設計 ([isbtty/deshi#247](https://github.com/isbtty/deshi/issues/247) の最終仕様コメント) では、受信した通知を session の **`messages_out` テーブル** にだけ書き込み、host の delivery polling loop に乗せて Telegram に届ける形にしていた。

設計の前提は「`messages_out` に書けば agent も自分の発言として認識でき、後続の追加質問で文脈を引き継いで応答できる」というものだった。

ところが PR #6 merge 後の動作確認で **会話継続性が成立しないこと** が判明した:

- 通知後にユーザーが Telegram で「さっきの通知について教えて」と返信しても、agent は「通知を送った記憶がない」と応答する
- DB 上は `messages_out` に inbound 由来の行が正しく存在しているが、agent の context にはそれが入っていない

調査の結果、次の事実が判明した:

1. agent-runner は **Anthropic Claude Agent SDK の native session continuation** (`session_state` の `continuation:claude` UUID) で会話を継続している
2. agent の「自分の発言履歴」の真実のソースは **Anthropic 側のクラウド SDK session** にあり、container 内 SQLite の `messages_out` テーブルではない
3. SDK session に積まれるのは「agent が Anthropic API を叩いて返ってきた assistant message」だけ。外部から `messages_out` に書き込んだ行は API を経由していないため SDK session には存在しない
4. upstream nanocoai/nanoclaw v2.0.64 でも agent-runner は `messages_out` を context 構築に一切使っていない (= upstream 追従では解消しない)

詳細経緯と裏取りは [isbtty/deshi#248](https://github.com/isbtty/deshi/issues/248) を参照。

joi さんの jibot (nanoclaw ベースの bot 実装) でも同種の通知配信ユースケースを実装しており、その実装パターンを相談したところ、**`messages_in` 側に書き込むのが正解** との指針を得た。本 ADR ではその指針の採用判断を文書化する。

## Decision

deshi daemon → nanoclaw への通知 push (`POST /inbound/deshi/skill-execution-notifications`) を以下の **両テーブル書き込み** に変更する:

| テーブル | 書き込み内容 | 目的 |
|---|---|---|
| `messages_out` | `kind='chat'`、content = `{text, files}` (既存 PR #6 の実装と同じ) | Telegram への **即時配信** (host の delivery polling が pickup) |
| `messages_in` | `kind='webhook'`、`trigger=0`、content = `{source: "deshi", event: "skill-execution-result", payload: {...}}` | agent の **context への注入** (起床はさせない) |

`messages_in` 書き込みは inbound handler 内で `messages_out` の隣で行い、deshi 側からは 1 回の HTTP 呼び出しで両方を実現する。書き込み順序は `messages_out` → `messages_in` を採用する (`messages_in` が先だと、agent 起床条件次第で意図しない race の可能性を残すため。trigger=0 でも防御的に順序を固定する)。

### 期待挙動 (会話継続性が成立する流れ)

1. deshi が `POST /inbound/deshi/skill-execution-notifications` を叩く
2. inbound handler が `messages_out` に書く → host delivery polling が拾って Telegram にプッシュ通知
3. inbound handler が同時に `messages_in` (`kind='webhook'`, `trigger=0`) にも書く → agent は起床しない (API コストゼロ)
4. ユーザーが Telegram で「さっきの通知について教えて」と返信
5. router が `messages_in` に `kind='chat-sdk'`, `trigger=1` で書く → `countDueMessages` がこれをカウントして agent 起床
6. agent が `getPendingMessages` で **両方** (`kind='webhook' trigger=0` + `kind='chat-sdk' trigger=1`) を取得
7. formatter が kind ごとに整形:
   ```xml
   <webhook source="deshi" event="skill-execution-result">
     {"text": "[通知] 添付ファイル付き通知です", "files": ["..."]}
   </webhook>
   <message from="telegram:...">さっきの通知について教えて</message>
   ```
8. agent が文脈を理解して応答 → SDK が prompt + 応答をクラウド session に記録 → **会話継続性が成立**

## `messages_in` の正しい意味 (周辺ナレッジとして重要)

本 ADR で文書化する最大の知見はこの一点。`messages_in` は **「ユーザーが入力した内容を入れるテーブル」ではない**。

`src/db/schema.ts` の DDL コメント:

> `messages_in` — Host-owned: inbound messages + delivery tracking + destination map.

「**container 内 agent から見た inbound (入力)** を集めるキュー」が正しい意味。書き込む主体はユーザー (= channel adapter 経由) に限らず、host 側の各種モジュールも書き込む。

### upstream で `messages_in` に書き込む既存実装

| 書き込み元 | 用途 | 代表 kind |
|---|---|---|
| `src/router.ts` | channel adapter 経由のユーザー実発言 | `chat` / `chat-sdk` |
| `src/modules/scheduling/actions.ts` | cron で発火する task | `task` |
| `src/modules/scheduling/db.ts` | reminder 再発火 | `task` |
| `src/modules/agent-to-agent/agent-route.ts` | 別 agent からの転送 | `chat-sdk` 等 |
| `src/modules/approvals/primitive.ts` | 承認カードの提示 | `chat-sdk` 等 |
| `src/modules/approvals/response-handler.ts` | 承認応答 | `chat-sdk` 等 |
| `src/modules/interactive/index.ts` | interactive モジュールからの注入 | (専用 kind) |
| `src/modules/self-mod/apply.ts` | container 再起動後の on_wake | `chat-sdk` 系 |
| `src/container-restart.ts` | restart 時のシステム通知 | `chat-sdk` |
| **本 ADR で追加: `src/deshi/inbound/`** | **deshi 起点の外部通知** | **`webhook`** |

agent 側 (`container/agent-runner/src/formatter.ts`) は `kind` ごとに別タグで整形する:

- `kind='chat'` / `'chat-sdk'` → `<message from="...">text</message>`
- `kind='task'` → `<task>...</task>`
- `kind='webhook'` → `<webhook source="..." event="...">payload</webhook>`
- `kind='system'` → `<system_response>...</system_response>` (※ ただし `poll-loop.ts` が `kind !== 'system'` でフィルタしているため、`system` kind は agent に届かない。MCP tool レスポンス専用)

→ agent から見ると「ユーザー発言」「外部 webhook 通知」「task 発火」などは明確に区別される prompt として流れるので、外部システムが `messages_in` に書いてもユーザー発言と誤認させることはない。

### `trigger` と `getPendingMessages` の役割分担

- 書き込み時の `trigger` (= `messages_in.trigger` カラム): `1` = agent を起床させる (default)、`0` = 起床させない (context-only)
- host 側 `src/db/session-db.ts` の `countDueMessages` は `WHERE trigger = 1` でカウント → trigger=0 行は起床判定に**含まれない**
- container 側 `container/agent-runner/src/db/messages-in.ts` の `getPendingMessages` は **trigger を見ない** → 起床時に trigger=0 / 1 を区別せず全件取得して agent prompt に乗せる

→ trigger=0 で書けば「**起床はしないが、次にユーザーが本物のメッセージで起床したときに context として agent prompt に乗る**」が実現される。API コストはゼロ。

## なぜパターン A (両テーブル書き込み) を採用したか

[isbtty/deshi#248 #issuecomment-4485979981](https://github.com/isbtty/deshi/issues/248#issuecomment-4485979981) で jibot さんから提示されたのは:

- **パターン A (Passive)**: `messages_out` 書き込み (配信) + `messages_in` `trigger=0` 書き込み (context)。本 ADR の採用案
- **パターン B (Active)**: `messages_out` 書き込みを廃止し、`messages_in` `trigger=1` で書く。agent が起床して自分で Telegram 向け文章を組み立てて `messages_out` に書く

A を選んだ理由:

1. **API コストが安い** — 通知 1 件あたり SDK 呼び出しゼロ。B は通知ごとに 1 turn 発生する
2. **配信の確実性** — `messages_out` 直接書きは agent の応答品質に依存しない。B は agent が指示通り通知を整形する保証が ChannelDestination の設定や agent の状態次第になる
3. **配信レイテンシ** — 通知到着 ~ Telegram 投稿が即時 (host polling は 1s 周期)。B は agent 起床 + SDK 呼び出しが介在するため数秒〜数十秒遅延する
4. **会話継続性も成立する** — A でも `messages_in` に webhook 行が積まれているため、ユーザー返信時に prompt に乗り SDK session に記録される

B のメリット (= 通知文面を agent が文脈に合わせて整形できる) は今のユースケース (cron task / backlog 実行結果の通知) では必要性が薄い。将来「agent が判断して通知文面をパーソナライズしたい」要件が出てきたら B への切り替えを再検討する。

## Consequences

### Positive

- 既存 PR #6 の `messages_out` 書き込みを残したまま追加で `messages_in` を書くだけなので、**Telegram 配信は既存と同じ即時性**を維持できる
- ADR-0002 を完全に守れる — upstream 編集ゼロ、deshi コードは `src/deshi/**` 配下のみ
- `messages_in` の正しい意味 (= ユーザー入力テーブルではなく agent への入力キュー) を ADR として記録するので、将来 inbound handler を追加するエンジニアが同じ誤解で詰まらない
- `kind='webhook'` という用途別 kind を upstream に依存して使えるので、formatter / SDK との統合は自動で動く (deshi 固有の prompt 整形ロジックを書かなくて良い)

### Trade-offs

- 同じ通知情報を `messages_out` (配信用) と `messages_in` (context 用) の 2 か所に書くことになる。冗長化の代償として、片方だけ書いて他方を忘れる実装ミスのリスクがある。inbound handler 内で必ず両方書く構造にして、テストで両方の存在を assert する
- `kind='webhook'` は upstream の formatter / poll-loop の仕様に依存する。upstream で webhook kind の扱いが変わった場合は追随が必要 (低頻度想定だが見落としには注意)
- 会話継続性は「次にユーザーがメッセージを送った時」に成立する。**ユーザーがその session に発言しないと webhook 行は SDK session に積まれない**。長期間返信されない場合、container TTL や session sweep で session 自体が消えると webhook 行も失われる (= 永続的な記憶ではない、あくまで「直近のコンテキスト保持」)

## See also

- ADR-0002 (namespace 隔離) — upstream ファイルへの侵襲ゼロを維持する根拠
- ADR-0010 (inbound HTTP handlers 命名) — 本 ADR の前提となる `src/deshi/inbound/` 系統の規約
- isbtty/deshi#247 — inbound endpoint 設計 issue
- isbtty/deshi#248 — 会話継続性の調査・検討 issue (jibot さんからの推奨パターン A 取得を含む)
- isbtty/nanoclaw#6 — inbound endpoint 初回実装 PR (本 ADR で挙動を改修する対象)
- upstream `src/db/schema.ts` — `messages_in` の DDL とコメント
- upstream `container/agent-runner/src/db/messages-in.ts` — `getPendingMessages` の挙動 (trigger に関係なく取得)
- upstream `container/agent-runner/src/formatter.ts` — `formatWebhookMessage` (kind='webhook' の整形)
- upstream `src/db/session-db.ts` — `countDueMessages` (trigger=1 のみ起床判定)
