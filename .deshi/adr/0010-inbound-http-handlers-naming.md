# ADR-0010: HTTP handler の命名規則 — MCP 経由 (host-tools) と外部 push 受信 (inbound) の分離

- Status: accepted
- Date: 2026-05-18
- Refs: isbtty/deshi#247, isbtty/deshi#205

## Context

ADR-0009 は **container 内 agent → MCP stdio → host-tools-server** という経路上の handler 命名を規定した。MCP の事実上の慣習 (snake_case tool 名) に従い、host 側の HTTP path / handler key / file 名はすべて `deshi_` prefix + snake_case で揃える、というルール。

一方、isbtty/deshi#247 で新たに **deshi daemon → nanoclaw host への直接 HTTP push** 経路を導入する。具体的には deshi daemon が backlog / heartbeat の skill 実行結果を nanoclaw に通知し、nanoclaw 側で session の `messages_out` に書き込んで既存 delivery polling に乗せる、という設計。この経路は:

- MCP を **介さない** (deshi daemon が `fetch()` で直接 HTTP を叩く)
- container 内 agent からは呼ばれない
- 外部システム (deshi daemon、将来は他の push 元) からの受信窓口になる

このため:

- MCP の snake_case 慣習に従う根拠がない (MCP を通らないため)
- 一般的な HTTP API として外部に露出するため、kebab-case が業界慣習として自然 (`POST /webhooks/github-push`, `POST /api/v1/user-profiles` 等)
- ADR-0009 の規約 (`/tools/deshi_xxx_yyy`) をそのまま流用すると、外部から見た時に「これは内部 MCP 用?」「外部公開用?」の区別がつかない

ADR-0009 を変更して両ケースを統一する選択肢もあるが、MCP 経由 handler は既に複数存在しており (`deshi_daemon_run_skill`, `deshi_daemon_poll_until_done`)、改名はリスクが大きい。新カテゴリを追加で定義する方が安全。

## Decision

1. **handler を 2 系統に分類する**

   | 系統 | 物理配置 | 命名規則 | ADR |
   |---|---|---|---|
   | **MCP-backed handlers** | `src/deshi/host-tools/` | snake_case + `deshi_` prefix | ADR-0009 |
   | **Direct HTTP receivers (inbound)** | `src/deshi/inbound/` | kebab-case (prefix 不要) | 本 ADR |

   判断基準は **「container 内 agent が MCP 経由で呼ぶか?」** の 1 点:
   - Yes → MCP-backed (host-tools/)
   - No → Direct HTTP receiver (inbound/)

2. **inbound handler の命名対比表**

   `POST /inbound/deshi/skill-execution-notifications` を例に:

   | layer | 命名 |
   |---|---|
   | HTTP path | `POST /inbound/deshi/skill-execution-notifications` |
   | handler key | `inboundHandlers["skill-execution-notifications"]` |
   | handler file | `src/deshi/inbound/skill-execution-notifications.ts` |
   | export 関数名 | `skillExecutionNotificationsHandler` (camelCase、JS 慣習) |
   | test file | `src/deshi/inbound/skill-execution-notifications.test.ts` |

   path prefix `/inbound/deshi/` の構造:
   - `/inbound/` — 外部システムからの受信窓口を表す共通 prefix
   - `/deshi/` — source identifier (どこから push されてくるか)。将来別 source からの push が増えた場合は `/inbound/<source>/<resource>` で並列に増やす
   - `/skill-execution-notifications` — resource 名 (kebab-case)

3. **host-tools-server.ts は両系統を 1 プロセスで dispatch する**

   既存の `POST /tools/<name>` dispatch と並列に、`POST /inbound/deshi/<name>` dispatch を追加する。物理プロセスは 1 つのまま、論理的に系統を分離する。

4. **認証 + body size limit**

   inbound endpoint は外部から叩かれるため、`Authorization: Bearer <DESHI_DAEMON_DEVICE_SECRET>` を **dispatch 側で一括検証** する (`timingSafeEqual` でタイミング攻撃対策)。MCP-backed handler は loopback 前提で無認証だったが、inbound は外部 push なので認証必須。

   body size は base64 inline 添付ファイルを想定して **20 MiB** まで許容 (`src/deshi/host-tools-server.ts` の `readJsonBody` 内で `MAX_BODY_BYTES` として規定、超過時は途中で接続を切って 400)。MCP-backed handler 側は元々こんなに大きい body を投げないため共有上限で問題なし。将来 10 MiB 超のファイルを扱う必要が出たら multipart/form-data への移行を検討する。

5. **`adapterSupportsThreads` の取得方法 — 静的マップで保持**

   inbound handler 内で session 解決時に必要な `adapterSupportsThreads` (channel adapter が thread を扱えるかどうか) は、**inbound 側に静的マップとして hard-code する**。

   理由:
   - host-tools-server は host 本体とは **別プロセス** で起動するため (`com.isbtty.nanoclaw.host-tools.plist`)、`initChannelAdapters()` が呼ばれず channel registry が空。`getChannelAdapter(channel)` を呼んでも `undefined` が返る
   - host-tools-server プロセス内で `initChannelAdapters()` を呼ぶ案は実用不可: Telegram bot polling や webhook receive が host 本体と二重に走り、メッセージが片方しか届かなくなる
   - request body で deshi 側から渡してもらう案は責務逆転 (deshi が channel capability を知る必要がある)

   採用する静的マップは upstream の `src/channels/<channel>.ts` の `supportsThreads` 値と一致させる。新規 channel が upstream に追加された / 既存 channel の `supportsThreads` が変わった場合、inbound 側マップを追随する責任は **deshi 側コミッタが負う** (CI チェックは ADR-0007 の `verify-layout.ts` 実装時に統合する候補)。

   マップは inbound handler ファイル内で定義し、コメントで「同期忘れリスクと根拠」を明記する。

6. **upstream `writeOutboundDirect` の readonly バグへの一時回避**

   inbound handler は messages_out への INSERT が必要だが、upstream `src/session-manager.ts:382` の `writeOutboundDirect` は内部で `openOutboundDb` (readonly handle) を呼んでおり、INSERT が `attempt to write a readonly database` で fail する。同種のバグは commit `8d022fd` で host-sweep 側 (`resetStuckProcessingRows`) が `openOutboundDbRw` への切り替えで修正されたが、`writeOutboundDirect` 側は未修正のまま残っている。

   ADR-0002 を守るため upstream を編集せず、inbound 側に `writeOutboundMessage` ヘルパを置いて `openOutboundDbRw` を直叩きする。SQL 本体は upstream `writeOutboundDirect` と同一 (`INSERT OR IGNORE`、seq は `MAX(seq)+2` で偶数を維持して host=even / container=odd の不変条件を守る)。cross-mount invariant (journal_mode=DELETE、open-write-close per op、one writer per file) も `openOutboundDbRw` が内部で守る。

   upstream で `writeOutboundDirect` の opener が writable に修正されたタイミングで、本 helper を削除して `writeOutboundDirect` 呼び出しに戻す。handler 内 doc コメントにも経緯と巻き戻し方法を明記済み。

7. **host-tools-server プロセスでの central DB 初期化**

   inbound handler は `getMessagingGroupByPlatform` / `getMessagingGroupAgents` / `resolveSession` 等を介して **central DB (`data/v2.db`)** を読み書きする。host-tools-server は host 本体 (`src/index.ts`) とは別プロセスで起動するため、host-tools-server プロセス内で **独自に `initDb()` を呼ぶ必要がある**。

   呼び出し位置: `src/deshi/host-tools-server.ts` の listen 前 (top-level)。migrations は実行しない (= host 本体側で既に走っている前提)。host-tools-server 側で重複 migrate を走らせると不要な race を引き起こす。

   なぜ別プロセスでも 1 つの DB ファイルを同時に握って良いか:
   - SQLite は WAL モード (`initDb` 内で `pragma journal_mode = WAL`) で multi-reader / single-writer をサポートする
   - host-tools-server は基本的に **読み取り中心** + ピンポイントな write (`resolveSession` の新規 session 作成、`messages_out` への INSERT)。host 本体側の writer と同時 write がぶつかってもブロックで吸収される
   - session DB (`inbound.db` / `outbound.db`) は別ファイルなので影響なし。cross-mount invariant (open-write-close per op) は session DB 限定の制約で、central DB には適用されない

   この決定は §5 の「別プロセスだから channel registry が空」と対称: 別プロセスである以上、process-global な状態 (channel registry、central DB connection) は **各プロセスで独自に立ち上げる** 必要がある、という一般則の系。本決定を漏らすと "Database not initialized. Call initDb() first." で実行時 fail する (テストは `initTestDb()` で自前 init するため検出できない)。

## Consequences

### Positive

- 外部 HTTP API の見た目が業界慣習 (kebab-case) に揃う → 外部システム実装者が直感的に扱える
- ADR-0009 を変更せず追加で拡張できる → 既存 MCP-backed handler の改名リスクを回避
- 判断基準が 1 点 (MCP 経由か否か) で明確 → 将来 handler 追加時に迷わない
- 認証ポリシーを系統ごとに分離 (MCP 経由 = loopback 前提無認証 / inbound = Bearer 必須) → 露出面に応じた適切な防御
- §7 で「inbound handler は中央 DB を触るので host-tools-server プロセス内での initDb 呼び出しが必須」と明記したので、将来 inbound handler を追加する人がプロセス境界の罠 (test では pass するが本番起動時に "Database not initialized" で fail) を踏みにくい

### Trade-offs

- handler 命名規則が 2 系統 (snake_case + kebab-case) に分かれるため、handler を追加する人が ADR-0009 / ADR-0010 のどちらに従うか判断する必要がある (判断基準は明確なので運用上は問題なし想定)
- `adapterSupportsThreads` の静的マップを upstream 実装と二重管理することになる → 同期忘れリスクが残る。新規 channel 追加時に inbound 側マップ更新を CONTRIBUTING / レビュー観点に含める運用で吸収する
- inbound endpoint は外部公開面が増えるため、認証 / size limit / レート制限の防御を handler 単位で意識する必要がある
- upstream `writeOutboundDirect` の readonly バグへの一時回避として inbound 側に `writeOutboundMessage` ヘルパを保持している。upstream 修正後に巻き戻しが必要で、その追跡が必要 (upstream PR 提出時に本 ADR の "See also" に追記する)
- host-tools-server プロセス内で central DB を独自に init するため、host 本体と host-tools-server で central DB connection が 2 つ存在する。SQLite WAL モードで safe だが、運用視点で「DB 接続が 2 か所」になる事実は意識が必要

## See also

- ADR-0002 (namespace 隔離) — upstream ファイルへの侵襲ゼロを維持する根拠
- ADR-0009 (MCP tool 命名) — 本 ADR の対比対象、`src/deshi/host-tools/` の命名規則
- ADR-0007 (verify-layout CI) — 将来 inbound 命名規則 + supportsThreads 静的マップの整合性チェックを統合する候補
- `src/deshi/host-tools-server.ts` — dispatcher 実装 (両系統を扱う)
- `src/deshi/inbound/skill-execution-notifications.ts` — 本 ADR で導入する最初の inbound handler
- isbtty/deshi#247 — inbound endpoint 設計 issue (本 ADR の起点)
- isbtty/deshi#205 — deshi 起点通知の全体設計 (#247 の親)
- isbtty/nanoclaw#6 — 本 ADR で規定した inbound endpoint の初回実装 PR (Decision 6 の workaround を含む)
