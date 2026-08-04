---
name: boswell-add-line
description: LINE Messaging API channel を nanoclaw に有効化する deshi 固有 skill。`src/deshi/channels/line.ts` の native adapter を前提に、`/boswell-setup-subdomain` (isbtty/deshi、admin-side) が発行した handoff package (subdomain / tunnel UUID / credentials JSON) を user 端末に配線し、credential 設定 / cloudflared を user LaunchAgent として常駐化 / LINE Developers Console 設定 / 疎通確認まで誘導する。
---

# LINE channel を nanoclaw に追加 (deshi 固有)

upstream `nanocoai/nanoclaw` に LINE adapter は存在しない。deshi fork (`isbtty/nanoclaw`) 側に native 実装 (`src/deshi/channels/line.ts`) を置いており、本 skill はその有効化手順を誘導する。

## 設計判断 (jibot3 さん由来 + isbtty/deshi#259 で確定)

- **native 実装** (Chat SDK bridge 不使用) — `@chat-adapter/line` が upstream に存在しないため
- **送信は push API 統一** (reply token 不使用) — reply token の寿命 ~1 分問題と状態管理を回避
- **supportsThreads = false** — LINE に thread 概念なし
- **`platformId` 形式**: `line:user:{id}` / `line:group:{id}` / `line:room:{id}`
- **inbound 添付**: `api-data.line.me` から DL → `DATA_DIR/attachments/` に保存 (`api.line.me` と別ホストである点に注意)
- **DM は `isMention=true`** — router が attentive モードに乗せるため

## 全体フロー (admin + user 視点)

```
  [admin 端末]                              [user 端末 = nanoclaw が動く Mac]
       │                                          │
       │  /boswell-setup-subdomain  (isbtty/deshi)  │
       │  ├─ Terraform で CF Access apps を生成   │
       │  │   • <user>-deshi   (deny-all)         │
       │  │   • <user>-webhook (bypass-all)       │
       │  │   • <user>-auth    (bypass-all)       │
       │  ├─ cloudflared tunnel create            │
       │  ├─ DNS route (<sub>.deshi.jp → tunnel)  │
       │  └─ handoff package を iCloud に出力     │
       │                                          │
       │           handoff package を手渡し         │
       │ ──────────────────────────────────────►  │
       │                                          │
       │                                          │  /boswell-add-line  (isbtty/nanoclaw、本 skill)
       │                                          │  ├─ コード presence check
       │                                          │  ├─ LINE Console で channel 準備
       │                                          │  ├─ .env に credential
       │                                          │  ├─ handoff package を ~/.cloudflared/ に配置
       │                                          │  ├─ user LaunchAgent で cloudflared 常駐
       │                                          │  ├─ nanoclaw 再起動
       │                                          │  └─ 疎通確認 + DM テスト
```

admin と user が同一人物の場合 (個人 install) は両 skill を同じ Mac で順番に走らせる。

## 進め方の原則

**1 ステップずつ user に確認を取りながら進める**。複数ステップを一度に提示すると人間は途中で詰まりやすい。`§2-a 完了 → §2-b 提示 → ...` の粒度で対話的に進行する。

## 概要 (本 skill 内のステップ)

1. コード presence check (idempotent)
2. LINE Developers Console で channel 準備 (a〜g、user の手作業)
3. credential を `.env` に書き込み
4. handoff package を取り込み + cloudflared を user LaunchAgent で常駐化
5. nanoclaw 再起動 + 疎通確認
6. bot に DM 送信 → owner 承認カード経由で wiring 成立 → 双方向対話確認
7. **応答モードの選択** — グループでの反応の仕方 (全応答 or メンションのみ+文脈蓄積) を選んで wiring に適用

> §2-d で LINE Console に Webhook URL を入れる欄は確認するだけで、URL 文字列は §4 で handoff package から決まるので、その時点で戻ってきて入力する。

---

## 1. コード presence check

LINE adapter 本体と barrel 配線が揃ってるか確認する。

### Pre-flight (idempotent)

以下が全部あれば「コード install 済み」 → §2 へ。

- `src/deshi/channels/line.ts` 存在
- `src/deshi/channels/index.ts` が `import './line.js';` を含む
- `src/channels/deshi.ts` 存在
- `src/channels/index.ts` が `import './deshi.js';` を含む
- `src/deshi/inbound/skill-execution-notifications.ts` の `SUPPORTS_THREADS` map に `line:` キーがある (`linear:` 等と区別するため真偽値まで確認)

```bash
test -f src/deshi/channels/line.ts \
  && grep -q "^import './line.js';" src/deshi/channels/index.ts \
  && test -f src/channels/deshi.ts \
  && grep -q "^import './deshi.js';" src/channels/index.ts \
  && grep -qE "^[[:space:]]*line:[[:space:]]*(true|false)" \
       src/deshi/inbound/skill-execution-notifications.ts \
  && echo "OK" || echo "Missing — see below"
```

### 不足分の補填

`src/deshi/channels/line.ts` が無い場合は main を pull:

```bash
git fetch origin main && git merge --ff-only origin/main
```

それでも無い場合は #259 がまだ merge されてない。手動で適用 (issue 参照)。

barrel の追記 (それぞれ無ければ):

```bash
grep -q "^import './line.js';" src/deshi/channels/index.ts \
  || echo "import './line.js';" >> src/deshi/channels/index.ts

test -f src/channels/deshi.ts || cat > src/channels/deshi.ts <<'EOF'
// deshi 固有 channel adapter の取り込み口 (barrel 1 行ルール ADR-0005)。
// 中身は src/deshi/channels/index.ts 側で管理する。
import '../deshi/channels/index.js';
export {};
EOF

grep -q "^import './deshi.js';" src/channels/index.ts \
  || printf '\n// deshi 固有 channel adapter (LINE 等) — barrel 1 行ルール (ADR-0005)\nimport "./deshi.js";\n' >> src/channels/index.ts
```

`SUPPORTS_THREADS` map に `line: false` を手動追記 (`src/deshi/inbound/skill-execution-notifications.ts`、map の末尾):

```ts
  // src/deshi/channels/line.ts (deshi 固有、LINE は thread 概念なし)
  line: false,
```

ビルド:

```bash
pnpm run build
```

---

## 2. LINE Developers Console で channel を準備

> ⚠️ LINE Console の UI は頻繁に変わる。本手順は 2026-05 時点。実画面の誘導と異なる場合はそちらに従いつつ、最終的に「Access Token / Channel Secret / Webhook URL が設定されていて、Auto-reply が OFF / Webhook が ON」になっていれば OK。
>
> 日本語 UI と英語 UI でラベルが異なる。両者を併記する。

### a. Provider 作成

[LINE Developers Console](https://developers.line.biz/console/) にログインして **Provider** (= LINE 公式アカウントを束ねる組織単位) を作成。名前は任意 (例: `dev-ops-<name>`、社内識別できる名前で OK)。

→ user に **Provider 名** を聞く。完了確認後 §2-b へ。

### b. Messaging API channel + Official Account 作成

Provider のページで「**Create a Messaging API channel** (Messaging API チャネルを作成)」。最近の UI は LINE Official Account 作成フローと統合されていて、公式アカウントを 1 つ作って Messaging API を許可する流れになる。画面の指示に従う。

→ user に **作成したアカウント名** を聞く。完了確認後 §2-c へ。

### c. 応答設定 (Auto-reply OFF / Webhook ON)

ここが詰まりがちなポイント。LINE は default で **Auto-reply messages (応答メッセージ)** が ON で、bot に DM 送ると「メッセージありがとうございます！…」というデフォルト自動返信が返り、webhook までイベントが届かない。

[Official Account Manager](https://manager.line.biz/) を別タブで開いて、該当アカウントを選択。

左メニューの **設定 (Settings)** → **応答設定 (Response settings)** で:

- **応答メッセージ (Auto-response messages)** → **オフ (Off)**
- **Webhook** → **オン (On)**
- (任意) あいさつメッセージ (Greeting message) → オフ推奨

→ user に「完了したか」確認。完了後 §2-d へ。

### c-2. グループ・複数人トーク参加を許可 (グループ運用するなら)

DM だけで運用するなら本ステップは skip 可。**グループ / 複数人トーク内で bot に話しかけたい場合は必須**。

[Official Account Manager](https://manager.line.biz/) → 該当アカウント → **設定 (Settings)** → **アカウント設定 (Account settings)** → **「機能の利用 (Feature usage)」** セクションの **「グループ・複数人トークへの参加 (Group / multi-person chat participation)」** を **オン** にする。

これが OFF だと:
- bot をグループに招待できない (招待しても入れない or 入っても発言を受け取れない)
- グループ内のメッセージが webhook に届かない (DM は届くがグループだけ詰まる)

→ user に「完了したか」確認。グループ運用しないなら skip と返答してもらう。完了後 §2-d へ。

### d. Webhook URL 入力欄の場所だけ確認 (URL 入力は §4 の後)

LINE Developers Console に戻って、該当 channel の **Messaging API settings (Messaging API 設定)** タブを開く。

そのタブの中に「**Webhook URL**」という入力欄があるはず。

- 欄が見つかれば OK
- 見つからない UI バージョンの場合は Official Account Manager (`https://manager.line.biz/account/<id>/setting/messaging-api`) にもあるか確認

URL 文字列自体は §4 で handoff package から決まる。**今は欄の場所を確認するだけ**。

→ user に「欄が見つかったか」確認。完了後 §2-e へ。

### e. Channel Access Token 発行

同じ **Messaging API settings (Messaging API 設定)** タブを下にスクロール。「**Channel access token (チャネルアクセストークン)**」セクション → **Issue (発行)** ボタン。

発行された長文トークン (150 文字程度の Bearer 文字列) をコピー。

→ user に **トークン文字列を貼ってもらう**。`.env` への書き込みは §3 で。

### f. Channel Secret 取得

**Basic settings (チャネル基本設定)** タブ (Messaging API settings の隣) を開く。ページ中ほどに「**Channel secret (チャネルシークレット)**」欄 (32 文字 hex)。値をコピー。

→ user に **secret 文字列を貼ってもらう**。

### g. Bot を友達追加

DM テストには bot を友達に追加する必要がある。

- **作業者の LINE アカウントで Provider / Official Account を作成した場合**: 作成時点で自動的に友達追加されている。何もしない
- **作業者 ≠ テスト LINE アカウント** の場合: Developers Console の Messaging API settings タブ下部の **QR コード** をテスト用 LINE で読み取って友達追加

→ user に「自動追加済み」or「QR で追加した」を確認。完了後 §3 へ。

---

## 3. Credentials を .env に書き込み

§2-e の access token と §2-f の channel secret を `.env` に書く (idempotent、既存値あれば上書き、無ければ append):

```bash
LINE_TOKEN='<paste-from-user>'
LINE_SECRET='<paste-from-user>'

for KV in "LINE_CHANNEL_ACCESS_TOKEN=${LINE_TOKEN}" "LINE_CHANNEL_SECRET=${LINE_SECRET}"; do
  KEY="${KV%%=*}"
  if grep -q "^${KEY}=" .env 2>/dev/null; then
    sed -i.bak "s|^${KEY}=.*|${KV}|" .env && rm -f .env.bak
  else
    printf '\n%s\n' "${KV}" >> .env
  fi
done
```

任意で port / path を変更したい場合 (default: `10280` / `/webhook`):

```
LINE_WEBHOOK_PORT=10280
LINE_WEBHOOK_PATH=/webhook
```

---

## 4. Handoff package を取り込み + cloudflared を user LaunchAgent で常駐化

本 skill は **subdomain / tunnel / CF Access apps の発行は別 skill (`/boswell-setup-subdomain`、admin-side、isbtty/deshi repo) に委譲する**。本セクションは発行済みの handoff package を user 端末に配線する役。

> 注意: deshi side の legacy `/boswell-connect-line` (旧 daemon plugin 方式) と本 skill (nanoclaw adapter 方式) は同じ LINE bot に対して並走させない。Webhook URL を奪い合うため必ずどちらか片方の運用に統一する。

### 4.0 既存設定の検出 (idempotent)

すでに配線済みなら §4.7 の疎通確認に飛ぶ。

```bash
# config.yml が存在し、nanoclaw の port (10280) を ingress に持っているか
test -f ~/.cloudflared/config.yml \
  && grep -q '10280' ~/.cloudflared/config.yml \
  && echo "config.yml: 10280 ingress 既設" \
  || echo "config.yml: 10280 ingress 不足"

# cloudflared が動いているか
{ pgrep -x cloudflared >/dev/null \
    || launchctl list | grep -q cloudflared; } \
  && echo "cloudflared: running" \
  || echo "cloudflared: 停止"
```

両方 OK → §4.7 へ。

### 4.1 ユーザに聞く: deshi URL は用意済みか

> ⚠️ 一般ユーザは `/boswell-setup-subdomain` や `handoff package` という用語を知らない。skill 内では **user-facing な言い回し** に倒すこと。

```
あなた用の deshi URL (例: dou.deshi.jp) は用意済みですか?

  - 用意済み → URL を教えてください
  - まだ → 弊社運営チームにご相談ください。発行されたら、その URL を持って
           このスキルに戻ってきてください
```

「用意済み」の場合は SUBDOMAIN を確定。

### 4.2 Handoff package の入手と検証

admin (= `deshi.jp` の Cloudflare Zone 権限 + Terraform 環境を持つ運用者) が **`/boswell-setup-subdomain`** (isbtty/deshi repo) を実行することで以下が生成されている前提:

| 成果物 | 形式 / 配置 |
|---|---|
| subdomain | `<user>.deshi.jp` |
| Cloudflare Access apps (3 個、Terraform 経由) | `<user>-deshi` (root deny-all) / `<user>-webhook` (`/webhook` bypass) / `<user>-auth` (`/auth` bypass) |
| Tunnel | `cloudflared tunnel create <user>-deshi` 経由 (UUID 発行) |
| DNS route | `<user>.deshi.jp` → tunnel UUID への CNAME (Cloudflare proxied) |
| handoff package | iCloud secrets の `handoff.json` + `<UUID>.json` |

admin と user が同一人物 (個人 install) の場合は、admin 側で `/boswell-setup-subdomain` を済ませてから本 skill を続行。別人の場合は handoff package を 1Password / age 暗号 / 対面など安全な経路で受け取る。

handoff package を確認:

```bash
SUBDOMAIN='<your-subdomain>'   # 例: otsuki
HANDOFF_ROOT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/deshi-raw/secrets/subdomains/${SUBDOMAIN}"

ls -la "$HANDOFF_ROOT/" 2>/dev/null \
  && jq . "$HANDOFF_ROOT/handoff.json"
```

handoff.json から UUID / tunnel name を取得:

```bash
TUNNEL_UUID="$(jq -r .tunnel_uuid "$HANDOFF_ROOT/handoff.json")"
TUNNEL_NAME="$(jq -r .tunnel_name "$HANDOFF_ROOT/handoff.json")"
echo "UUID=$TUNNEL_UUID  NAME=$TUNNEL_NAME"
```

handoff package が無い場合は本 skill を一旦中断し、運営チームに依頼する。

### 4.3 Credentials JSON を ~/.cloudflared/ に配置

```bash
mkdir -p ~/.cloudflared
cp "$HANDOFF_ROOT/${TUNNEL_UUID}.json" ~/.cloudflared/
chmod 600 "$HOME/.cloudflared/${TUNNEL_UUID}.json"
```

`~/.cloudflared/cert.pem` は user 端末では **不要** (handoff の credentials JSON だけで tunnel run できる)。

### 4.4 ~/.cloudflared/config.yml を作成/更新

既存の config.yml に他の tunnel ingress が同居している可能性があるので **全消ししない**。LINE 用 hostname の ingress を追加する。

既存が無いなら新規作成:

```bash
cat > ~/.cloudflared/config.yml <<EOF
tunnel: ${TUNNEL_UUID}
credentials-file: ${HOME}/.cloudflared/${TUNNEL_UUID}.json

ingress:
  - hostname: ${SUBDOMAIN}.deshi.jp
    service: http://localhost:10280
  - service: http_status:404
EOF
```

既存 config.yml がある場合は手動で ingress 配列の先頭に LINE 用 hostname の route を挿入する (`service: http_status:404` のフォールバック行は配列末尾に保つ)。

### 4.5 cloudflared CLI を確認 + user LaunchAgent を作成

cloudflared 未インストールなら入れる:

```bash
command -v cloudflared >/dev/null || brew install cloudflared
```

> なぜ user LaunchAgent (sudo 不要) を採用するか
>
> - `sudo cloudflared service install` (引数なし) は plist の `ProgramArguments` を `cloudflared` バイナリのみで生成する罠があり、tunnel run しない壊れた daemon ができる
> - nanoclaw 本体も `~/Library/LaunchAgents/com.nanoclaw.plist` の user LaunchAgent パターンで動いており整合する
> - sudo 不要 = skill UX シンプル、user 権限で `~/.cloudflared/` を素直に読める

LaunchAgent plist を作成:

```bash
CLOUDFLARED_BIN="$(command -v cloudflared)"
PLIST=~/Library/LaunchAgents/com.cloudflare.cloudflared.plist

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflare.cloudflared</string>
    <key>ProgramArguments</key>
    <array>
        <string>${CLOUDFLARED_BIN}</string>
        <string>--no-autoupdate</string>
        <string>tunnel</string>
        <string>--config</string>
        <string>${HOME}/.cloudflared/config.yml</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/cloudflared.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/cloudflared.err.log</string>
</dict>
</plist>
EOF
```

ロード (起動):

```bash
launchctl bootstrap gui/$(id -u) "$PLIST" 2>/dev/null \
  || launchctl load "$PLIST"

launchctl list | grep cloudflared
```

PID が表示されれば起動。8〜10 秒待って edge 接続:

```bash
sleep 10
cloudflared tunnel info "$TUNNEL_NAME" | tail -3
# CONNECTOR が 1 個以上、EDGE 列に nrt 等の location が出ていれば OK
```

### 4.6 LINE Console の Webhook URL を設定

§2-d の場所に貼って Save:

```
https://<subdomain>.deshi.jp/webhook
```

「Use webhook」を ON。Verify ボタンは §5 で nanoclaw を再起動した後に押す。

### 4.7 疎通確認 (CF Access + tunnel + nanoclaw を通す)

> `curl` の対象は **`/webhook` 直叩き** に限定する。CF Access の bypass app は path 完全一致 (`/webhook`) で設定されており、`/webhook/foo` 等のサブパスは別挙動 (deny-all にフォールバック) の可能性があるため。

```bash
SUBDOMAIN='<your-subdomain>'

echo "--- POST /webhook (CF Access bypass-all が効くはず) ---"
curl -s -o /dev/null -w "status=%{http_code}\n" -X POST \
  https://${SUBDOMAIN}.deshi.jp/webhook \
  -H 'Content-Type: application/json' -d '{}'
# 期待: 401 (= nanoclaw の LINE adapter の signature 検証が反応している証拠)

echo "--- GET / (CF Access deny-all が効くはず) ---"
curl -s -o /dev/null -w "status=%{http_code}\n" https://${SUBDOMAIN}.deshi.jp/
# 期待: 302 (= cloudflareaccess.com にリダイレクトされる)
```

判定:

- `/webhook` が **401** → 配線完璧。§5 へ
- `/webhook` が **302** → CF Access の `<user>-webhook` bypass app が無いか、policy 順序が壊れている。admin に確認依頼
- `/webhook` が **530 (error code 1033)** → tunnel が edge と connection を持っていない。`launchctl list \| grep cloudflared` で daemon 確認、`cloudflared tunnel info "$TUNNEL_NAME"` で connector 確認、`/tmp/cloudflared.err.log` も確認
- `/webhook` が **502** → tunnel は通ったが nanoclaw 側で port 10280 が listen してない。§5-a の再起動を先に走らせる

---

## 5. nanoclaw 再起動 + 疎通確認

### a. ビルド & 再起動

LINE adapter を読み込むには nanoclaw プロセスを再起動する。

```bash
pnpm run build

# macOS (launchd) — マッチした全 nanoclaw label を再起動する
launchctl list | awk '/com\.nanoclaw/ {print $3}' \
  | xargs -I{} launchctl kickstart -k "gui/$(id -u)/{}"

# Linux (systemd)
# systemctl --user restart nanoclaw
```

`logs/nanoclaw.log` の末尾に以下が出るのを確認:

```
LINE webhook server listening port=10280 path="/webhook"
Channel adapter started channel="line" type="line"
```

### b. LINE Console の Verify

§2-d で URL を入れた状態で、Developers Console の Webhook URL 横の「**Verify**」ボタンを押す。**Success** と出れば疎通完了。

(失敗時は §4.7 の判定表に戻る)

---

## 6. bot に DM して動作確認 (auto-registration 経由)

bot に好きなテキストで DM を 1 通送る。

### 想定される nanoclaw の動き (初回のみ)

1. webhook 着信、adapter が `Channel metadata discovered` ログ
2. messaging_group を自動作成 (`Auto-created messaging group`)
3. unknown sender なので owner の DM チャネル (例: Telegram) に「この LINE sender をどの agent_group に wire しますか?」の承認カードが届く (`Channel registration card delivered`)
4. owner がカード上で agent_group を選択 → wiring 成立 (`Channel registration approved — wiring created`)
5. session が走り、agent 応答が LINE に返る (`Message delivered channelType="line"`)

### 確認

```bash
tail -200 logs/nanoclaw.log | grep -iE "\bline\b|channel registration"
```

bot が agent の返事を LINE で受け取れば e2e 成立。2 回目以降の DM は承認カード無しで agent に届く。

> wiring が成立したら **§7 で応答モードを選ぶ**。特にグループ運用する場合は §7 を必ず通す (auto-registration のデフォルトが LINE グループでは意図とズレるため、下記参照)。

---

## 7. 応答モードの選択 (グループの反応の仕方)

wiring が成立すると、agent が「いつ反応するか」は wiring の `engage_mode` / `ignored_message_policy` で決まる。ここを初期設定で user に選ばせる。

### DM は常に全応答 (設定不要)

LINE adapter は DM を無条件で `isMention=true` にする (`src/deshi/channels/line.ts`)。router 側でも DM は必ず engage するため、**DM は engage_mode に関わらず毎回応答する**。DM の wiring は触らなくてよい。

### グループの初期デフォルト = 「見守りモード」

§6 の承認フローで wiring を自動生成するとき、`src/modules/permissions/index.ts` はグループの `engage_mode` を **`mention`**、`ignored_message_policy` を **`accumulate`** で作る。

つまり **LINE グループは初期状態で「メンション時のみ応答 + 非メンションは文脈蓄積」= 下記 A モード**になっている。A で良ければ §7 は確認だけで済む。**全応答 (B) にしたい場合のみ上書きが必要**。

> 前提: グループ判定は `event.message.isGroup`（アダプタが立てるフラグ）を優先し、無ければ `threadId !== null` にフォールバックする。LINE は `supportsThreads=false` で `threadId` が常に `null` だが、adapter が `isGroup=true` を立てるので正しくグループと判定される (この配線が無いと threadId=null により DM 扱い→`pattern` 全応答に誤配線されていた)。

### user に聞く: グループでの反応モード

```
LINE グループでの bot の反応の仕方を選んでください:

  A) 見守りモード (推奨・初期デフォルト)
     - メンション (@アシスタント名 or LINE の mention) された時だけ返信
     - 非メンションの発言も「文脈」として溜めておき、次に呼ばれた時に前後の
       流れを踏まえて答える (返信はしない)
     - engage_mode=mention / ignored_message_policy=accumulate
     - ★ auto-registration の初期値がこれ。A なら追加操作は基本不要

  B) 全応答モード
     - グループの全メッセージに毎回反応する
     - にぎやかなグループだと過剰・トークン消費大。専用の作業グループ向け
     - engage_mode=pattern (.) / ignored_message_policy=accumulate
```

DM しか使わないなら「グループなし」と答えてもらい、本セクションは skip。

### 対象グループ wiring の特定

グループの wiring は、bot がそのグループにいて誰かが発言し §6 の承認を通した後に存在する。まだ無いなら、そのグループで一度発言 → 承認してから戻る。

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT mga.id AS wiring_id, mg.platform_id, mg.name, mga.engage_mode, mga.engage_pattern, mga.ignored_message_policy
     FROM messaging_group_agents mga
     JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
    WHERE mg.channel_type='line' AND mg.is_group=1"
```

該当行の `wiring_id` を控える (複数グループあれば各行に対して適用する)。

### モードを適用

**A) 見守りモード** (メンションのみ応答 + 文脈蓄積) — 初期デフォルト。上の確認クエリで既に `mention` / `accumulate` なら何もしなくてよい。明示的に戻したい/古い wiring を直す場合のみ:

```bash
ncl wirings update <wiring-id> --engage_mode mention --ignored_message_policy accumulate
```

**B) 全応答モード**:

```bash
ncl wirings update <wiring-id> --engage_mode pattern --engage_pattern . --ignored_message_policy accumulate
```

適用後、再度上の q.ts クエリで `engage_mode` / `ignored_message_policy` が意図通りか確認する。反映は次のメッセージから効く (container 再起動は不要)。

> メンション判定は adapter の `isBotMentionedInGroup` が担当する: LINE の正式な mention (`mention.mentionees` に bot userId or `type:'all'`) か、本文に アシスタント名 (`ASSISTANT_NAME`) が含まれれば mention 扱い。

---

## トラブルシュート

| 現象 | 原因 / 対処 |
|---|---|
| 自動返信「メッセージありがとうございます！…」が返る | §2-c の応答メッセージが ON。Official Account Manager 側で OFF |
| 「Verify」で 302 (cloudflareaccess.com に飛ばされる) | CF Access の `<user>-webhook` (path: `/webhook`, bypass-all) アプリが無い or 順序壊れ。admin に `/boswell-setup-subdomain` 再実行を依頼 |
| 「Verify」で 401 | nanoclaw まで届いているが signature 検証で落ちている。`LINE_CHANNEL_SECRET` が間違いか、§5-a の再起動忘れで古い secret で起動 |
| 「Verify」で 502 / 530 (1033) | tunnel が edge と接続できていない。`cloudflared tunnel info <name>` で connector を確認、`/tmp/cloudflared.err.log` を確認 |
| `LINE webhook server listening` ログが出ない | credential 未設定 = factory が `null` を返してスキップ。§3 の `.env` を再確認 |
| bot に DM しても何も起きない | (1) Webhook OFF (§2-c) (2) Webhook URL の typo (§4.6) (3) nanoclaw が新コードを反映してない (§5-a の build + kickstart 忘れ) |
| **グループで非メンションの発言にも全部反応してしまう** | wiring が `engage_mode=pattern` (`.`) になっている。B モードを選んだ or `isGroup` 判定修正前に作られた古い wiring (threadId=null で DM 誤判定)。§7-A (`engage_mode=mention`) で上書きする |
| グループでメンションしても反応しない | (1) §2-c-2 のグループ参加が OFF で webhook が届いてない (2) mention 判定に失敗 — `@` に続けて `ASSISTANT_NAME` を正確に打つか、LINE の mention 機能で bot を選ぶ。`logs/nanoclaw.log` の `LINE group message` 行で `botMentionedInGroup` を確認 |
| handoff package が見つからない | admin (運営チーム) が `/boswell-setup-subdomain` を未実行。依頼する |
| cloudflared が起動しない | `~/.cloudflared/<UUID>.json` の権限 (600) を確認 / `~/.cloudflared/config.yml` の path が絶対パスか確認 (`~` ではなく `${HOME}` 展開済) |
| 「`cloudflared` を `cloudflared service install` で system daemon 化した方が良い?」 | 非推奨。引数なし install は壊れた plist (`tunnel run` を渡さない) を作る既知 UX バグあり。本 skill は user LaunchAgent に倒している |
| **MacBook の蓋を閉じてスリープすると LINE 通知が来ない** | LaunchAgent / Daemon どちらでも Mac がスリープすれば cloudflared も止まる。常時受信したい場合は §下記 sleep 抑止オプションを参照 |

### MacBook で sleep 抑止したい場合 (任意)

Mac mini や clamshell (外部ディスプレイ + 蓋閉じ運用) では不要。MacBook を蓋閉じで持ち運ぶ場合に LINE 不通になるのが許容できないなら以下:

```bash
# 蓋閉じ後もスリープしない (要 sudo)
sudo pmset -a disablesleep 1

# 現状確認
pmset -g
```

**デメリット**:
- バッテリー駆動時もスリープしない = 電池消費が激しい (電源差し忘れで完全放電のリスク)
- ファン回りっぱで筐体温度上昇
- 蓋を閉じてカバンに入れて移動すると過熱の懸念

戻す:
```bash
sudo pmset -a disablesleep 0
```

---

## scope 外

- 本 skill は **LINE adapter の有効化のみ**。deshi 側 `LineNotifier` の廃止 (isbtty/deshi#259 Step 4) は別 skill で扱う。
- subdomain / tunnel / CF Access apps の発行は **`/boswell-setup-subdomain`** (isbtty/deshi、admin-side) に委譲する。本 skill 内ではそれらを作らない。
- outbound 添付 (画像送信) は未対応 (テキストのみ)。
- `ask_question` の LINE Quick Reply 化は未実装 (テキストフォールバック)。

## 関連

- `/boswell-setup-subdomain` (isbtty/deshi) — admin-side で subdomain / tunnel / CF Access apps を発行
- `/boswell-connect-line` (isbtty/deshi、legacy) — 旧 daemon plugin 方式での LINE 接続 skill。本 skill (nanoclaw adapter 方式) と用途が競合するため並走させない
- isbtty/deshi#259 — LINE channel adapter を nanoclaw 側で持つ件 + LineNotifier 廃止
