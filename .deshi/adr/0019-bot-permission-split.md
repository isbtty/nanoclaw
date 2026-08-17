# ADR-0019: 権限分離は BOT の物理分離で行う — 知識検索BOT / 管理者BOT の 2 インスタンス構成

- Status: accepted (実装待ち)
- Date: 2026-08-06
- Refs: isbtty/boswell#642, ADR-0018 (Slack instance 登録), ADR-0020 (sender token)

## Context

研究室運用 (生物化学研究室ルーム等) で、同じチャンネルに 2 種類の利用者が混在する:

- **外部研究生 (tier A)**: 研究内容について BOT に質問する。公開された知識の検索・質問のみ。
- **研究室の管理者 (tier B/C)**: boswell の skill 実行・成果物作成・調査まで行う。tier B と C は当面区別しない。

当初は単一 BOT の内部でユーザー単位に権限を分ける案 (isbtty/boswell#642 の Role tier A/B/C) を検討したが、
`ChannelContext` (boswell `daemon/src/routes/run.ts`) に発言者個人を識別する field が無く、
boswell daemon 側で per-user のゲートを掛けられない。#642 自身がこれをブロッカーとして明記している。

一方 nanoclaw には既に以下が揃っている:

- `messaging_groups.instance` を軸にした **N インスタンス並走** (ADR-0018 で Slack の登録手段まで設計済み)
- `user_roles` (owner / admin、global または agent group scoped) + `agent_group_members` による user 単位の権限
- agent group ごとの `container_configs.mcp_servers` → **agent-runner が `allowedTools` を自動生成**するため、
  BOT ごとの tool surface が**プロンプトではなくランタイムで**強制される

チャンネルは Slack 固定とする。

## Decision

**ユーザー単位のゲートを 1 BOT の内部に作るのではなく、BOT を物理的に 2 つに分ける。**
権限の境界を「どちらの BOT に話しかけられるか」「その BOT が何を持っているか」に一致させる。

### 0. 適用範囲 — セットアップスキルを実行した対象だけ

本 ADR の構成が必要なのは**一部の顧客・一部のチャンネルだけ**であり、全顧客に配るものではない。
したがって:

- **既存の挙動は一切変えない。** 既存の agent group / messaging group / 承認ルーティングは無変更で動き続ける。
- 挙動が変わるのは、**セットアップを通った対象に限る**。判定は env フラグではなく DB で行い、
  2 段になっている (詳細は §5.1):
  **host が権限分離運用か** (`permission_split_config`、1 行だけの設定) と、
  **その agent group が権限分離済みか** (`permission_split_groups`)。
  個々の分岐 (DM の scope-link 抑止、権限操作の即時実行) が見るのは後者で、実体は
  `permission_split_groups` テーブル (migration 021) と `src/deshi/permission-split.ts` の
  `isPermissionSplitGroup()`。**分岐を入れる側は必ずこれを通し、false のときは従来どおりの
  経路をそのまま走らせること。**
  行が無い agent group は従来運用のまま — 同じ host 上で両方が併存する。
- 知識検索BOT の instance は ADR-0018 の env 宣言が無ければそもそも登録されないので、
  導入していない環境では BOT 自体が存在しない。

「未配線チャンネルで無反応」「権限付与を即時実行」等の新しい挙動も、すべてこの適用範囲の内側でのみ効く。

### 1. BOT とインスタンス

| BOT | instance | 役割 |
|---|---|---|
| 管理者BOT | **primary** (upstream の `SLACK_BOT_TOKEN` = instance `slack`) | skill 実行・調査・成果物・権限管理 |
| 知識検索BOT | named instance (ADR-0018 の `slack-<suffix>`) | 公開範囲の知識検索と、それに基づく回答のみ |

**instance 登録のコードは新規に要らない。** ADR-0018 の `src/deshi/channels/slack-instances.ts`
(isbtty/nanoclaw#72 で実装済み) がそのまま使える。`DESHI_SLACK_WORKSPACES` は名前こそ
「ワークスペース」だが、機構は **1 bot token = 1 instance** なので、**同一ワークスペースに 2 つ目の
Slack App を入れる**本構成でも同じ経路で登録できる。env にサフィックスと token を足して host を
再起動するだけで、コア (upstream 管理ファイル) への diff はゼロ。env 宣言が無ければインスタンスは
登録されないため、導入していない環境には知識検索BOT がそもそも存在しない (§0 の適用範囲と整合)。

管理者BOT を primary にするのは、ADR-0018 既知制約 1 のため。cold DM と承認カードの配送は
`getChannelAdapter('slack')` の channelType フォールバックで **primary インスタンスに解決される**。
承認カードが知識検索BOT から届くのは事故なので、管理者BOT を primary 側に置く。

### 2. agent group の粒度

- **管理者BOT: 1 チャンネル = 1 agent group。** nanoclaw の scoped admin は agent group 単位なので、
  「チャンネル内 admin」を既存の `user_roles(role='admin', agent_group_id=<そのチャンネルの group>)` で
  そのまま表現できる。チャンネル単位の admin 概念を新設しない。
- **知識検索BOT: 1 agent group で全チャンネル、`session_mode='shared'`。** 知識の可視範囲は
  boswell 側 `ChannelScopeStore` が channelId キーで既に分離しており、`container.json` も全チャンネル共通。
  `shared` ならセッション (= コンテナ) はチャンネル単位で割れるので、チャンネル間のコンテキスト混線も起きない。

**知識検索はチャンネルでのみ受け付ける。DM は対象外**とする。BOT の用途がチャンネル単位の
公開知識に閉じているため、DM での検索を成立させる意味がない。`ChannelScopeStore` は
deny-by-default なので、DM の channelId に scope を設定しなければ**自動的に何も答えられない**
状態になる (追加実装は不要)。セットアップスキルは知識検索BOT の wiring を
**グループチャンネルにのみ**作り、DM には作らない。

### 3. ロール階層 (3 層)

| 層 | 実体 | 付与経路 |
|---|---|---|
| 特権admin | global admin (`user_roles`, `agent_group_id IS NULL`) | **チャットからは不可**。開発チームが host 上で `ncl roles grant` (`/deshi-manage-nanoclaw-admins`)。初期は導入者のみ |
| チャンネル内admin | scoped admin (`agent_group_id` = そのチャンネルの group) | セットアップ時に自動付与 + チャット指示で付与/剥奪 |
| tier A | ロール無し (既定) | — |

- 特権admin は全チャンネルのセットアップができる。チャンネル内 admin は**自分のチャンネル内でのみ**
  他ユーザーを admin に昇格・降格できる。
- 管理者BOT のメンバー間に tier B/C の差は設けない。使える skill は boswell 側の
  `expose-to-nanoclaw` allowlist が付いているもの全部。

### 4. 知識検索BOT の tool surface

知識検索BOT の `container.json` には **`/boswell-knowledge-search` 固定で boswell に投げる host-tool 1 本だけ**を
載せる (汎用の `boswell_run_start` は載せない)。回答の生成は boswell 側が行う
(boswell ADR-0003 / ADR-0010 の「nanoclaw は検閲・配送のみ、判断は boswell」を維持)。

この host-tool は **channelId を引数で受け取らない**。host 側で ADR-0020 の sender token から解決する。

### 5. チャンネルのセットアップ — 既存の承認フローに相乗りする

**セットアップ専用の合言葉は用意しない。** チャンネル登録の承認フローが完了した時点で、
必要な配線を host が自動で続けて行う。

理由は 2 つ:

- **承認カードを押せるのは owner/admin だけ**なので、承認の完了そのものが「特権admin の意思表示」に
  なっている。別途の合言葉も本人確認も要らない
- 招待 → メンション → 承認 → 返事、という既存の導線に乗るので、利用者が覚えることが増えない

#### 5.1 host 単位のフラグ

「この host が権限分離運用か」を **host 単位** (agent group 単位ではなく) で持つ。

```
permission_split_config  … 1 行だけの設定
  knowledge_agent_group_id   知識検索BOT の agent group (招待先の解決に使う)
  knowledge_instance         slack-<suffix>
  enabled_at
```

行が有る = この host に生える BOT は既定で権限分離前提。行が無ければ従来運用のまま。
この行は **§5.3 の初回セットアップ (host 上で operator が実行) でだけ**作られる。

agent group 単位の `permission_split_groups` (§0) との関係:

- `permission_split_config` … **この host が権限分離運用か**。チャンネル登録時の分岐に使う
- `permission_split_groups` … **その agent group が権限分離済みか**。個々の判定 (DM の scope-link
  抑止、権限操作の即時実行) に使う

チャンネル登録の時点ではそのチャンネルの agent group がまだ存在しないため、前者が要る。

#### 5.2 チャンネル登録時に host が自動で行うこと

チャンネル登録の承認 (`handleChannelApprovalResponse`) が wiring を作った直後、
`permission_split_config` の行が有れば続けて:

1. その agent group を `permission_split_groups` に登録
2. 承認した特権admin と、チャンネル管理者に scoped admin を付与
3. 知識検索BOT をそのチャンネルに招待 (`conversations.invite`)
4. **知識検索BOT 側のチャンネル登録を先回りで済ませる。** これが無いと、招待された
   知識検索BOT の最初の発言でもう一度承認カードが出て agent group を人手で選ばされ、
   「承認を押すだけで完了」が成立しない。`messaging_groups` は `instance` 違いの別行に
   なる (`UNIQUE(channel_type, platform_id, instance)`) ので、同じチャンネルに対して
   policy を別々に持てる — 知識検索BOT 側は `public` + `sender_scope='all'` にして、
   外部の人が承認を待たずに質問できるようにする (tier A)。知識の範囲は
   `ChannelScopeStore` が deny-by-default で別途縛る
5. **チャンネルに完了を投稿する**。host からチャンネルへの投稿は配送アダプタ
   (`getDeliveryAdapter().deliver`) に instance 付きで渡す。DM 配送と同じ経路で、
   セッションを必要としない

当初案にあった「承認カードの配送先を Slack へ切り替える (`user_dms` リダイレクト)」は
**不要と判断して落とした**。`pickApprovalDelivery` が元々「依頼元と同じ channel_type の
承認者を優先」するため、Slack 起点の依頼は何もしなくても Slack の admin に届く
(実機で確認済み)。`user_dms` の書き換えは既存の配送先を壊しうる操作なので、
効果が重複する以上やらない。

なお 1〜5 のどこで失敗しても**承認フロー自体は止めない**。この処理は承認 handler の
途中から呼ばれ、後段に元メッセージの replay と知識スコープリンクの配送が控えている。
throw するとチャンネルは配線済みなのにそれらが飛び、カードだけ成功表示で残る。

行が無ければ 1〜5 を丸ごと飛ばし、従来どおりの挙動になる。

知識検索BOT の可視範囲 (`ChannelScopeStore`) の設定はここに含めず、後から
`/update-knowledge-scope` で行う。deny-by-default なので、設定するまで知識検索BOT は何も答えられない。

チャンネル管理者の特定は `conversations.info` の `creator` を使う。Slack の「チャンネル管理者」
ロールは公開 Web API から一覧できないため。取れなければ特権admin だけを admin にして、
チャンネルへの完了投稿で「管理者を追加するには @Bot に依頼してください」と案内する。

チャンネル情報の取得と知識検索BOT の招待は chat-sdk のアダプタが公開していないため、
host から Slack Web API を直接叩く。使うのは primary instance の bot token なので、
**named instance のチャンネルでは試みない** (誤った workspace を触らないため)。

#### 5.3 初回セットアップ (host 上、operator が実行)

host 1 台につき 1 回だけ行う。ここで `permission_split_config` の行が作られる。

1. 前提チェック — `/add-slack` 済みか、Slack App のスコープが足りているか。
   **不足していれば何も変更せず、不足分を提示して停止する**
2. 2 つ目の Slack App の作成とインストール (**手作業**) → token を受け取る
3. `.env` に `DESHI_SLACK_WORKSPACES` サフィックスと `SLACK_BOT_TOKEN_<S>` / `SLACK_APP_TOKEN_<S>` を追記
4. host 再起動、instance が起動したことをログで確認
5. 知識検索BOT 用の agent group 作成 + `container.json` (§4 の host-tool だけ)
6. 導入者を特権admin として登録
7. `permission_split_config` に行を作る

Slack App の作成だけ手作業に残すのは、App Manifest API に configuration token (`xoxe-`) が要り、
それ自体が管理画面での発行作業で 12 時間で失効するため。自動化しても手作業が消えない。
加えて App の追加はワークスペースに対して不可逆に近いので、人が確認しながら行う方が安全。

`pickApprovalDelivery` は元々「依頼元と同じ channel_type の承認者を優先」する実装なので、
Slack 起点の依頼は Slack の admin に届く。ただし到達判定に `ensureUserDm` (= `conversations.open`) を
使うため、**Slack App に `im:write` スコープが無いと Slack の admin が到達不能と判定され、
他プラットフォームの承認者にフォールバックする** (実測で確認済み)。スコープは前提条件とする。

### 6. 権限の付与・剥奪

`@管理者BOT @対象者 に権限を付与して` / `外して` をチャット指示で受け、**承認カードを挟まず即時実行**する。
「誰の依頼か」の判定は ADR-0020 の sender token による。

## Consequences

- boswell daemon 側は **per-user の識別を持たなくてよい**。#642 の Role tier 軸 (`min-tier` frontmatter +
  `UserRoleStore`) は本 ADR で代替されるため、当面実装しない。#642 の Scope 軸 (wiki の `visibility`) は残る。
- 権限の境界が「BOT」という利用者から見えるオブジェクトに一致するので、運用説明が容易になる。
- BOT ごとの能力差は `container_configs.mcp_servers` → `allowedTools` で効くため、
  プロンプトの言い聞かせに依存しない。

### 既知の制約 (受容する)

1. **チャンネル数だけ agent group とコンテナが増える** (管理者BOT 側)。コンテナは常駐ではなく
   発言で起きてアイドルで落ちるため、同時稼働数はアクティブなチャンネル数に留まる。
2. **`cli_scope='global'` を持つ agent group は実質「特権経路」になる。** cli_scope は agent group 単位で
   ユーザー単位ではないため、その group のメンバーシップを厳密に握る必要がある。特権admin と
   チャンネル内 admin の差は ADR-0020 の sender token 判定で付ける。
3. **ADR-0018 の制約を継承する**: instance サフィックスは運用開始後は改名不可 (改名 = 別インスタンス新設で
   `messaging_groups` 行と Chat SDK state が orphan 化)、`slack.ts` ミラーは upstream 追従時に手で差分確認が要る。
4. **role は instance 非依存**。`slack:<U-id>` は両 BOT で同一ユーザーとして扱われる。同一ワークスペース内の
   2 BOT 構成では意図通りだが、将来ワークスペースを跨ぐ場合は注意。
5. **Slack App が 2 つ必要**。知識検索BOT 側の追加とトークン投入 (`.env`) と host 再起動は container の外側の
   作業なので、開発チームが行う。
6. **Slack App のスコープ棚卸しが前提条件になる。** 実測で `im:write` 不足により
   `ensureUserDm` が失敗し、承認カードが別プラットフォームへフォールバックする事象を確認した。
   知識検索BOT の自動招待 (`conversations.invite`) にも別途スコープが要る。セットアップスキルは
   起動時にスコープの充足を検査し、不足していれば何も変更せずに不足分を提示して停止する。
7. **既存環境との共存**。適用範囲 (§0) の外にある agent group / user_dms / 承認ルーティングには
   一切触れない。同じ host 上で従来通りの運用と本構成が併存する。
8. **`messaging_groups.is_group` はアダプタ依存**。router の auto-create は
   `is_group: event.message.isGroup ? 1 : 0` (`src/router.ts`) で決めており、threadId の有無は見ない。
   「知識検索はチャンネルのみ、DM は対象外」の判定はこのフラグに乗るため、`message.isGroup` を
   立てないアダプタが入ると、そのチャンネルが DM 扱いになり知識が黙って無効化される。
   Slack / LINE / Telegram は実データで正しく立っていることを確認済み。

## 実機検証 (2026-08-06)

本 ADR が前提にしている経路を、稼働中の host (Slack 接続済み) で実際に通した結果:

| 検証項目 | 結果 |
|---|---|
| Slack 起点の承認カードが Slack の admin に届く | ✅ `approver` が Slack の admin に解決。他プラットフォームへフォールバックせず直行 |
| cold DM の解決 (`ensureUserDm` → `conversations.open`) | ✅ `im:write` 追加後に成功し `user_dms` へ自動登録 |
| 知識スコープ編集リンクの発行・配送 | ✅ `Scope-link delivered to recipient` |
| 承認 → wiring 作成 → セッション起動 | ✅ 一連で完走 |
| scope 未設定チャンネルでの知識検索 | ✅ deny-by-default で「検索できない」と応答 (追加実装なしで要件を満たす) |

同時に、本 ADR 以前から存在した障害を 2 件検出して解消した:

1. **`im:write` 欠落** — Slack の admin が到達不能と判定され、承認カードが他プラットフォームへ
   フォールバックしていた。Slack App にスコープ追加で解消。
2. **device secret 不一致** — nanoclaw 側 `DESHI_DAEMON_DEVICE_SECRET` と boswell daemon の
   `DAEMON_DEVICE_SECRET` の値が食い違い、`POST /knowledge/scope-link` が 401 で失敗していた。
   `boswell_run_start` が動いていたのは daemon 側の「localhost かつ body に channelContext があれば
   素通し」という escape hatch (isbtty/boswell#677) のおかげで、secret 検証を通る経路だけが
   死んでいた。両キー (`BOSWELL_` / `DESHI_`) に正しい値を設定して解消。

## 受容したリスク — 実装完了時にまとめて再確認する

設計・実装の過程で「今は目を瞑る」と判断したものの一覧。実装が一通り終わった時点で
この節を上から見直し、依然として受容できるか / 対策を入れるかを判断する。

| # | リスク | 現在の扱い | 再確認の観点 |
|---|---|---|---|
| 1 | **乗っ取られた container が同席者になりすます**。inbound.db は container から読めるため、prompt injection で他人のメッセージを「処理中」と印を付ければその人として振る舞える (ADR-0020) | 受容。sender token が消せるのは事故による取り違えと、TTL による古い発言の再利用まで | tier A が公開ルームに直接書ける構成なので、injection の入口は実在する。container 隔離側で緩和できるか |
| 2 | **`cli_scope='global'` を持つ agent group は実質「特権経路」**。cli_scope は agent group 単位でユーザー単位ではない | 受容。特権admin とチャンネル内admin の差は sender token 判定で付ける | その group のメンバーシップを誰が変更できるかを塞げているか |
| 2b | **host 実行に落とせばゲートを通らない**。container が `daemon_run_skill` で boswell daemon に skill 実行を投げると、host 上で起動した Claude が `ncl` を `caller: 'host'` として叩ける。`dispatch` のゲートは `caller !== 'host'` のときだけ走るため、`--group` 無しの `roles grant` で global admin を発行できる | 受容。本設計以前から存在する経路で、boswell daemon 側 (別 repo) の実行許可にも依存する | ゲートを caller に依らず効かせるか、host 実行経路から `ncl` の権限操作を落とすか |
| 3 | **Slack Channel Manager の API 取得可否が未確認**。admin 系 API が使えないプランでは `creator` へフォールバックする | 未確認のまま設計 | 対象ワークスペースのプランを確認し、フォールバックで実運用に耐えるか |
| 4 | **instance サフィックスは運用開始後に改名不可**。改名すると `messaging_groups` 行と Chat SDK state が orphan 化する | 受容。命名を最初に確定させる運用でカバー | セットアップスキルが命名を固定できているか |
| 5 | **`slack.ts` ミラーのドリフト** (ADR-0018 制約 4)。upstream 更新が named instance に自動追随しない | 受容。`/deshi-update-from-upstream` のチェックリストで人間が確認 | チェックリストに項目が入っているか |
| 6 | **知識検索BOT は scope 未設定の間、何も答えられない**。deny-by-default | 意図した挙動 | 新規ルームのたびに owner がボトルネックにならないか |

## 不採用案

- **(a) 単一 BOT + per-user tier (#642 の Role tier 軸)**: boswell に senderId を渡す passthrough 拡張が前提で、
  かつ container 経由の申告値になるため詐称耐性が弱い。BOT 分離なら同じ保証をより単純に得られる。
- **(b) 知識検索BOT の回答生成を nanoclaw の container 内で完結させる**: tool surface は最小になるが、
  「脳は boswell」という boswell ADR-0003 / ADR-0010 の前提を崩す。
- **(c) `session_mode='agent-shared'` で 1 コンテナに全チャンネルを集約**: コンテナ数は減るが、
  `writeSessionRouting` がセッションの `messaging_group_id` 由来のため「今どのチャンネルか」が
  最初の 1 つに固定される。加えて全チャンネルの会話が 1 コンテキストに混ざり、研究室間で内容が混線する。
- **(d) チャンネル単位の admin テーブルを新設**: 1 チャンネル = 1 agent group にすれば既存の scoped admin で
  足りるため、新しい権限軸を増やす理由がない。

## See also

- Slack instance 登録の機構: ADR-0018
- 発言者と channel の権威的解決: ADR-0020
- boswell 側の知識スコープ: isbtty/boswell#396, `daemon/src/services/channel-scope-store.ts`
- boswell 側の skill allowlist: boswell ADR-0002 (`expose-to-nanoclaw`)
- 知識検索と作業の分離: boswell ADR-0010
