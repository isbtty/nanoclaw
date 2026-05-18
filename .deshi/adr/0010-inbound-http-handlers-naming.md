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

4. **認証**

   inbound endpoint は外部から叩かれるため、`Authorization: Bearer <DESHI_DAEMON_DEVICE_SECRET>` を **dispatch 側で一括検証** する (`timingSafeEqual` でタイミング攻撃対策)。MCP-backed handler は loopback 前提で無認証だったが、inbound は外部 push なので認証必須。

5. **`adapterSupportsThreads` の取得方法 — 静的マップで保持**

   inbound handler 内で session 解決時に必要な `adapterSupportsThreads` (channel adapter が thread を扱えるかどうか) は、**inbound 側に静的マップとして hard-code する**。

   理由:
   - host-tools-server は host 本体とは **別プロセス** で起動するため (`com.isbtty.nanoclaw.host-tools.plist`)、`initChannelAdapters()` が呼ばれず channel registry が空。`getChannelAdapter(channel)` を呼んでも `undefined` が返る
   - host-tools-server プロセス内で `initChannelAdapters()` を呼ぶ案は実用不可: Telegram bot polling や webhook receive が host 本体と二重に走り、メッセージが片方しか届かなくなる
   - request body で deshi 側から渡してもらう案は責務逆転 (deshi が channel capability を知る必要がある)

   採用する静的マップは upstream の `src/channels/<channel>.ts` の `supportsThreads` 値と一致させる。新規 channel が upstream に追加された / 既存 channel の `supportsThreads` が変わった場合、inbound 側マップを追随する責任は **deshi 側コミッタが負う** (CI チェックは ADR-0007 の `verify-layout.ts` 実装時に統合する候補)。

   マップは inbound handler ファイル内で定義し、コメントで「同期忘れリスクと根拠」を明記する。

## Consequences

### Positive

- 外部 HTTP API の見た目が業界慣習 (kebab-case) に揃う → 外部システム実装者が直感的に扱える
- ADR-0009 を変更せず追加で拡張できる → 既存 MCP-backed handler の改名リスクを回避
- 判断基準が 1 点 (MCP 経由か否か) で明確 → 将来 handler 追加時に迷わない
- 認証ポリシーを系統ごとに分離 (MCP 経由 = loopback 前提無認証 / inbound = Bearer 必須) → 露出面に応じた適切な防御

### Trade-offs

- handler 命名規則が 2 系統 (snake_case + kebab-case) に分かれるため、handler を追加する人が ADR-0009 / ADR-0010 のどちらに従うか判断する必要がある (判断基準は明確なので運用上は問題なし想定)
- `adapterSupportsThreads` の静的マップを upstream 実装と二重管理することになる → 同期忘れリスクが残る。新規 channel 追加時に inbound 側マップ更新を CONTRIBUTING / レビュー観点に含める運用で吸収する
- inbound endpoint は外部公開面が増えるため、認証 / size limit / レート制限の防御を handler 単位で意識する必要がある

## See also

- ADR-0002 (namespace 隔離) — upstream ファイルへの侵襲ゼロを維持する根拠
- ADR-0009 (MCP tool 命名) — 本 ADR の対比対象、`src/deshi/host-tools/` の命名規則
- ADR-0007 (verify-layout CI) — 将来 inbound 命名規則 + supportsThreads 静的マップの整合性チェックを統合する候補
- `src/deshi/host-tools-server.ts` — dispatcher 実装 (両系統を扱う)
- `src/deshi/inbound/skill-execution-notifications.ts` — 本 ADR で導入する最初の inbound handler
- isbtty/deshi#247 — inbound endpoint 設計 issue (本 ADR の起点)
- isbtty/deshi#205 — deshi 起点通知の全体設計 (#247 の親)
