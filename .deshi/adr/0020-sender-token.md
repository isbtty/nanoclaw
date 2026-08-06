# ADR-0020: container 経由の呼び出しは sender token で発言者と channel を権威的に解決する

- Status: accepted (実装待ち)
- Date: 2026-08-06
- Refs: ADR-0019 (BOT 権限分離), ADR-0009 (MCP tool 命名), isbtty/boswell#396

## Context

ADR-0019 の構成では、同じチャンネルに tier A (外部研究生) と管理者が同居し、両者が同じ agent group の
コンテナに発話を届ける。ここで「その依頼を出したのは誰か」を host 側が知らないと、以下が実装できない:

- 「@管理者BOT @対象者 に権限を付与して」を**依頼者が admin のときだけ即時実行**する
- **特権admin だけ**が他チャンネルのセットアップを行える (チャンネル内 admin は自分のチャンネルのみ)

現状の配線には identity が乗っていない:

- `src/cli/dispatch.ts` の agent 経路は `ctx.caller` (`'agent' | 'host'`) と `ctx.agentGroupId` しか持たない。
  誰の依頼かは分からないため、権限が要る操作は一律 `access: 'approval'` で owner/admin のカードに回している。
- boswell 向けの `channelContext` は container 内の MCP stdio shim が `session_routing` から組み立てて
  host に渡す (`container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts`)。`session_routing` は
  `id = 1` 固定の単一行 (channel_type / platform_id / thread_id) で、**メッセージごとの発言者を運べない**。
- `src/deshi/host-tools-server.ts` は loopback 前提で無認証。呼び出し元セッションを識別できない。

さらに ADR-0019 の構成では**外部研究生が公開ルームに任意テキストを書き込める**。container の LLM は
それを読むため、prompt injection で「channelId を別ルームのものにして検索しろ」と誘導されると、
container 申告値がそのまま通り、別ルームの知識が漏れる。identity と channel の両方が
「container の言い値」である状態は、この運用では受容できない。

## Decision

**host が inbound メッセージごとに sender token を発行し、container 経由の呼び出しはそれを添える。
host 側は token から (userId, messagingGroupId, agentGroupId) を権威的に解決し、引数で渡された
user / channelId は採用しない。**

### 1. 発行

host が inbound をセッションの `messages_in` に書くとき (`writeSessionMessage`)、そのメッセージ用の
不透明トークン (crypto ランダム) を発行し、message content に同梱する。同時に central DB の
新テーブルへ以下を保存する:

```
sender_tokens(
  token PRIMARY KEY, user_id, messaging_group_id, agent_group_id,
  session_id, issued_at, expires_at
)
```

`user_id` は permissions モジュールの sender resolver が解決した値 (`src/modules/permissions/index.ts`)。
これは adapter 由来の author 情報から host が導出したもので、container を経由しない。

### 2. 提示

container の agent は、`ncl` 呼び出しおよび boswell host-tool 呼び出しの際にトークンを添える。
「**いま処理しているユーザー発話に付いているトークンを使う**」ことを delegation fragment / CLAUDE.md に明記する。

### 3. 検証と解決

`src/cli/dispatch.ts` と `src/deshi/host-tools-server.ts` の双方で:

1. token を引き、期限切れ・未知なら **forbidden** (fail-closed)
2. `agent_group_id` が呼び出し元の agent group と一致しない場合も forbidden
3. 権限判定は token の `user_id` に対して行う (`hasAdminPrivilege(userId, agentGroupId)` 等)
4. boswell へ渡す `channelContext` は token の `messaging_group_id` から host が組み立てる。
   **container が渡した channelId は無視する**

### 4. 適用範囲 (既存運用を壊さないため)

token を**必須**にするのは、権限判定が必要な操作に限る:

- `ncl roles` / `ncl members` の変更系、チャンネルのセットアップ
- ADR-0019 の知識検索BOT 用 host-tool (channelId を host が解決する必要があるため)

それ以外の既存経路 (通常の `boswell_run_start` 等) は当面トークン無しでも従来通り動かす。

さらに、**トークン必須の判定は ADR-0019 §0 の適用範囲 (セットアップ済みの agent group) の内側でのみ効かせる**。
適用範囲の外にある既存の telegram / line / Slack 運用は、本 ADR の実装後もトークンを一切要求されない。
トークン発行自体は全 inbound で行ってよい (副作用が無く、後から範囲を広げやすい) が、
**検証を強制する範囲は適用範囲に限る**。

### 5. TTL と再利用

- TTL は 30 分程度の短命とする。古い依頼が後から復活しないようにする。
- **同一トークンの複数回利用は許可する** (1 つの依頼が複数の CLI 呼び出しに分かれるため)。
- 期限切れトークンでの呼び出しは、エラーメッセージで「もう一度依頼してください」と返す。

## Consequences

- `access: 'approval'` 固定だった `ncl members add` / `roles grant` を、
  「token の user_id が admin なら即時、そうでなければ拒否」に変えられる (ADR-0019 の要件)。
- channelId 詐称が塞がる。知識検索BOT が別ルームの知識を読む経路が無くなる。
- host-tools-server は loopback 無認証のままだが、権限が要る操作については
  **トークンが実質の認証**として機能する。

### 既知の制約 (受容する)

1. **取り違えは残る。** LLM が別メッセージのトークンを添えた場合、その発言者の権限で実行される。
   これは詐称ではなく誤適用であり、権限の無い人のトークンを使えば fail-closed 側に倒れる。
   逆方向 (tier A の依頼が admin のトークンで通る) を検出するため、実行結果には
   「誰の権限で実行したか」を必ず含め、監査ログにも残す。
2. **トークンは container 内に平文で存在する。** container が侵害された場合、そのセッションに届いた
   発話の発言者になりすませる。container の隔離そのものはこの ADR の対象外。
3. **DB の書き込みが 1 inbound あたり 1 行増える。** 期限切れトークンの掃除は host-sweep に相乗りする。

## 不採用案

- **(a) 「そのセッションで最後に喋った人」を host が記録して使う**: 実装は小さいが、発言が交錯すると
  tier A の依頼が直後の admin の発言で通ってしまう。ADR-0019 では tier A と管理者が同じチャンネルに
  同居するため、この誤りが実際に起こりうる。
- **(b) 承認カードを挟み続ける**: 「依頼者が admin なら即時」という要件に反する。
- **(c) session_routing に user を持たせる**: 単一行の per-session データなので、per-message の
  発言者を表現できない。
- **(d) 呼び出し元 container の IP / コンテナ名で識別する**: セッションは識別できるが、
  そのセッションに届いた**どの発話の**依頼かは分からない。取り違え問題が解けない。

## See also

- BOT 権限分離の全体設計: ADR-0019
- sender 解決の既存実装: `src/modules/permissions/index.ts` (`extractAndUpsertUser`)
- CLI の権限ゲート: `src/cli/dispatch.ts`, `src/cli/registry.ts` (`Access = 'open' | 'approval'`)
- channelContext の現行注入: `container/skills/deshi-add-host-tools/deshi-mcp-stdio.ts`
