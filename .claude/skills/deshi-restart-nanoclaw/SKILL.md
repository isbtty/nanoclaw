---
name: deshi-restart-nanoclaw
description: nanoclaw の常駐環境 (host / host-tools / コンテナ) を最新ソースに refresh する — git pull / pnpm build / launchd kickstart / コンテナ再 spawn / health check をまとめて実行 (project)
user-invocable: true
allowed-tools: Bash, Read
---

# `/deshi-restart-nanoclaw` — nanoclaw 環境リフレッシュ

## 概要

nanoclaw (isbtty/nanoclaw fork) の常駐環境を「最新の健全な状態」に揃える運用スキル。
deshi 側の `/deshi-restart-services` の nanoclaw 版 (別スキル・別リポジトリ)。

対象は 3 つ:

| target | launchd label | 実行形態 | build 要否 | health |
|---|---|---|---|---|
| `host` | `com.nanoclaw-v2-<slug>` (動的解決) | `node dist/index.js` | **要 `pnpm build`** (tsc → dist) | PID + webhook port TCP |
| `host-tools` | `com.isbtty.nanoclaw.host-tools` (固定) | `tsx src/deshi/host-tools-server.ts` | 不要 (tsx 直実行) | `curl /health` (:5180) |
| `containers` | (launchd 管轄外) | per-session docker container | 不要 (RO bind-mount) | `docker ps` の再 spawn |

加えて、上記の restart 前に **OneCLI Gateway の SDK/サーバ整合を毎回 probe** する
(Step 4.5)。これは target ではなく常時プリフライトで、ズレを検知したときのみ
サーバを upgrade する (詳細は Step 4.5)。

### このスキルの前提 (重要)

- **host 側 operator が nanoclaw リポジトリを cwd にした Claude Code セッション**から
  実行する。nanoclaw コンテナ経由 (channel 越し) での実行は想定しない。
- `host` label は install slug (`sha1(projectRoot)[:8]`、`src/install-slug.ts`) 由来で
  ホスト毎に変わる。**ハードコードせず `launchctl list` から動的解決**する。
- `container/agent-runner/src` と `container/CLAUDE.md` は **RO bind-mount でイメージに
  焼かれない** (`src/container-runner.ts`、Dockerfile「Source is never baked in」)。
  よってコード変更の反映は**コンテナ再 spawn のみ**で足り、イメージ再ビルドは
  Dockerfile / 依存 (apt・npm・bun.lock) を変えたときだけ。

## 引数

```
/deshi-restart-nanoclaw [flags...] [target...]
```

| flag | 効果 |
|---|---|
| `--no-pull` | git pull をスキップ |
| `--no-build` | pnpm build をスキップ |
| `--rebuild-image` | コンテナイメージを `./container/build.sh` で再ビルド (重い。Dockerfile/依存変更時のみ) |
| `--quick` | pull + build をスキップ (kickstart + health のみ) |

target 省略時は `all` (= `host host-tools containers`)。複数指定可。

## 実行手順

### Step 1: 引数解析 + リポジトリ解決

```bash
set -uo pipefail

DO_PULL=1; DO_BUILD=1; REBUILD_IMAGE=0
declare -a TARGETS=()

for arg in "$@"; do
  case "$arg" in
    --no-pull)       DO_PULL=0 ;;
    --no-build)      DO_BUILD=0 ;;
    --rebuild-image) REBUILD_IMAGE=1 ;;
    --quick)         DO_PULL=0; DO_BUILD=0 ;;
    all)             TARGETS+=(host host-tools containers) ;;
    host|host-tools|containers) TARGETS+=("$arg") ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)  echo "unknown target: $arg (expected: host|host-tools|containers|all)" >&2; exit 2 ;;
  esac
done

[ "${#TARGETS[@]}" -eq 0 ] && TARGETS=(host host-tools containers)
TARGETS=($(printf '%s\n' "${TARGETS[@]}" | awk '!seen[$0]++'))

# nanoclaw リポジトリ root (cwd 起点 → fallback)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO_ROOT" ] && REPO_ROOT="$HOME/code/nanoclaw"
UID_NUM="$(id -u)"

# host label を動的解決 (install slug 由来)
HOST_LABEL="$(launchctl list 2>/dev/null | awk '$3 ~ /^com\.nanoclaw-v2-/ {print $3; exit}')"
HOSTTOOLS_LABEL="com.isbtty.nanoclaw.host-tools"

echo "[restart-nanoclaw] repo:    $REPO_ROOT"
echo "[restart-nanoclaw] targets: ${TARGETS[*]}"
echo "[restart-nanoclaw] host label: ${HOST_LABEL:-<not loaded>}"
```

### Step 2: git pull

```bash
if [ "$DO_PULL" = 1 ] && [ -d "$REPO_ROOT/.git" ]; then
  echo; echo "[restart-nanoclaw] === git pull ==="
  cd "$REPO_ROOT"
  CUR=$(git rev-parse HEAD 2>/dev/null)
  if git pull --ff-only 2>&1 | sed 's/^/  /'; then
    NEW=$(git rev-parse HEAD 2>/dev/null)
    [ "$CUR" = "$NEW" ] && echo "  already up to date" || echo "  $CUR → $NEW"
  else
    echo "  pull failed (continuing with local HEAD)"
  fi
fi
```

### Step 3: pnpm build (host が対象のときのみ)

`host` は `node dist/index.js` で動くため tsc → dist の反映が必須。`host-tools` は
tsx が src を直実行するのでビルド不要。

```bash
NEEDS_BUILD=0
for t in "${TARGETS[@]}"; do [ "$t" = "host" ] && NEEDS_BUILD=1; done

if [ "$DO_BUILD" = 1 ] && [ "$NEEDS_BUILD" = 1 ]; then
  echo; echo "[restart-nanoclaw] === pnpm build (host) ==="
  cd "$REPO_ROOT"
  pnpm install --silent 2>&1 | tail -3 | sed 's/^/  /' || { echo "  pnpm install failed" >&2; exit 3; }
  if pnpm build 2>&1 | tail -5 | sed 's/^/  /'; then
    [ -f dist/index.js ] && echo "  dist/index.js mtime: $(stat -f '%Sm' dist/index.js 2>/dev/null)"
  else
    echo "  build failed; aborting" >&2; exit 4
  fi
fi
```

### Step 4: コンテナイメージ再ビルド (--rebuild-image 指定時のみ)

通常フローでは不要 (ソースは RO bind-mount)。Dockerfile / apt / npm / bun.lock を
変えたときだけ。

```bash
if [ "$REBUILD_IMAGE" = 1 ]; then
  echo; echo "[restart-nanoclaw] === container image rebuild ==="
  cd "$REPO_ROOT" && ./container/build.sh 2>&1 | tail -10 | sed 's/^/  /'
fi
```

### Step 4.5: OneCLI Gateway 整合 (capability probe / 常時・冪等)

**probe は必ず毎回走る**。フラグでの無効化や個別 target 化はしない — バージョンずれは
「こちらが気づかないうちに」起きる (`pnpm install` が `@onecli-sh/sdk` を上げても、
`~/.onecli` の常駐サーバは `latest` 解決で古いイメージのまま取り残される) ため、
opt-in / opt-out は本末転倒。**重い upgrade (vault recreate) が走るのはズレを検知したときのみ**、
一致時は完全 no-op。

ホスト側 `ensureAgent`(`createAgent → POST /v1/agents`)は container spawn の前提。
SDK が `/v1/*` を要求するのにサーバが `/api/*` しか持たないと 404 → spawn 失敗 →
「typing のまま無限に固まる」(isbtty/deshi#523 別障害)。**サーバを SDK に合わせてから**
host/containers を再起動する必要があるので、Step 5 (restart) の**前**に置く。

判定は version 文字列比較ではなく **capability probe** (SDK/サーバの semver に対応関係が
無いため)。named volume (`pgdata` / `app-data`) は維持されるので **agent 登録・secret は保持**。

```bash
echo; echo "[restart-nanoclaw] === OneCLI Gateway 整合 ==="

OC_PORT=10254; OC_BASE="http://127.0.0.1:$OC_PORT"
probe_code() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$OC_BASE/$1/agents" 2>/dev/null; }

if ! docker inspect onecli >/dev/null 2>&1; then
  echo "  - onecli コンテナ無し (native credential proxy 等) — skip"
else
  # 1) 稼働中 SDK が要求する API prefix を実体 (.mjs) から検出
  SDK_MJS=$(ls "$REPO_ROOT"/node_modules/.pnpm/@onecli-sh+sdk@*/node_modules/@onecli-sh/sdk/lib/index.mjs 2>/dev/null | head -1)
  WANT=api
  if [ -n "$SDK_MJS" ] && grep -q '/v1/agents' "$SDK_MJS" 2>/dev/null; then WANT=v1; fi
  echo "  SDK が要求する prefix: /$WANT  (${SDK_MJS:-SDK未検出→/api 前提})"

  # 2) サーバ能力を probe (毎回・軽量)
  V1=$(probe_code v1); API=$(probe_code api)
  echo "  server probe: /v1/agents=$V1  /api/agents=$API"

  # 3) 不整合 (SDK=/v1 なのにサーバが /v1/agents=404) のときだけ upgrade
  if [ "$WANT" = v1 ] && [ "$V1" = 404 ]; then
    echo "  ⚠ 不整合: SDK は /v1 を要求するがサーバは /v1/agents=404 (旧 API のみ)"

    # pin 運用なら silent 上書きせず警告に留める (reproducibility を壊さない)
    OC_PIN=""
    [ -f "$REPO_ROOT/.env" ] && OC_PIN=$(grep -m1 '^ONECLI_VERSION=' "$REPO_ROOT/.env" | cut -d= -f2- | tr -d '"' | sed 's/^latest$//')
    [ -n "$OC_PIN" ] && echo "  ⚠ .env が ONECLI_VERSION=$OC_PIN を pin 中 — pull が新版を取らない可能性。/v1 非対応なら手動 bump が必要 (自動書換はしない)。"

    # compose 定義を docker label から動的解決 (ハードコードしない)
    OC_COMPOSE="$(docker inspect onecli --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null)"
    if [ -z "$OC_COMPOSE" ] || [ ! -f "$OC_COMPOSE" ]; then
      echo "  ✗ compose file を解決できず (label=${OC_COMPOSE:-none}) — 手動対応:"
      echo "      cd ~/.onecli && docker compose pull onecli && docker compose up -d onecli"
    else
      echo "  compose: $OC_COMPOSE  → pull + up -d onecli..."
      ( cd "$(dirname "$OC_COMPOSE")" && docker compose pull onecli && docker compose up -d onecli ) 2>&1 | tail -5 | sed 's/^/    /'

      # health 待ち: healthy かつ /v1/agents!=404 の二段確認 (最大 60s)
      ok_upg=0; hs=none
      for _ in $(seq 1 30); do
        hs=$(docker inspect onecli --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null)
        c=$(probe_code v1)
        if { [ "$hs" = healthy ] || [ "$hs" = none ]; } && [ -n "$c" ] && [ "$c" != 404 ]; then
          echo "  ✅ OneCLI 整合完了 (health=$hs, /v1/agents=$c)"; ok_upg=1; break
        fi
        sleep 2
      done
      if [ "$ok_upg" = 0 ]; then
        echo "  ❌ upgrade 後も /v1/agents が回復せず (health=$hs, /v1/agents=$(probe_code v1))"
        [ -n "$OC_PIN" ] && echo "    → ONECLI_VERSION=$OC_PIN の pin が /v1 非対応の可能性大。pin を bump して再実行を。"
      fi
    fi
  else
    echo "  ✓ OneCLI サーバは SDK と整合済み — no-op"
  fi
fi
```

### Step 5: kickstart (host / host-tools) + コンテナ再 spawn (containers)

```bash
echo; echo "[restart-nanoclaw] === restart ==="
for target in "${TARGETS[@]}"; do
  case "$target" in
    host)
      if [ -z "$HOST_LABEL" ]; then
        echo "  ✗ host: launchd label が見つからない (未 setup / 別ホスト?) — skip"
      elif launchctl kickstart -k "gui/$UID_NUM/$HOST_LABEL" 2>/dev/null; then
        echo "  ✓ host ($HOST_LABEL) kickstarted"
      else
        echo "  ✗ host ($HOST_LABEL) kickstart failed"
      fi
      ;;
    host-tools)
      if launchctl kickstart -k "gui/$UID_NUM/$HOSTTOOLS_LABEL" 2>/dev/null; then
        echo "  ✓ host-tools ($HOSTTOOLS_LABEL) kickstarted"
      else
        echo "  ✗ host-tools ($HOSTTOOLS_LABEL) kickstart failed (未 load?)"
      fi
      ;;
    containers)
      # 稼働中コンテナを kill。次のメッセージ受信時に新ソースで fresh 起動する。
      names=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '^nanoclaw-v2-' || true)
      if [ -n "$names" ]; then
        echo "$names" | xargs -r docker kill >/dev/null 2>&1 || true
        echo "  ✓ containers killed (次受信で再 spawn): $(echo "$names" | tr '\n' ' ')"
      else
        echo "  - containers: 稼働中なし (次受信で新ソース起動)"
      fi
      ;;
  esac
done
```

### Step 6: 起動待ち + ヘルスチェック

```bash
echo; echo "[restart-nanoclaw] waiting 8s..."; sleep 8

# webhook port (.env の WEBHOOK_PORT、default 3000)
WEBHOOK_PORT=3000
if [ -f "$REPO_ROOT/.env" ]; then
  v=$(grep -m1 '^WEBHOOK_PORT=' "$REPO_ROOT/.env" | cut -d= -f2- | tr -d '"')
  [ -n "$v" ] && WEBHOOK_PORT="$v"
fi

echo; echo "[restart-nanoclaw] === after ==="
ok=0; fail=0
for target in "${TARGETS[@]}"; do
  case "$target" in
    host)
      [ -z "$HOST_LABEL" ] && { echo "  - host: label 無し (skip)"; continue; }
      pid=$(launchctl list | awk -v l="$HOST_LABEL" '$3==l{print $1}')
      if [ -n "$pid" ] && [ "$pid" != "-" ] && nc -z -G 2 127.0.0.1 "$WEBHOOK_PORT" 2>/dev/null; then
        echo "  ✅ host: pid=$pid + webhook :$WEBHOOK_PORT 応答"; ok=$((ok+1))
      else
        echo "  ❌ host: pid=${pid:-none} / webhook :$WEBHOOK_PORT 無応答"; fail=$((fail+1))
      fi
      ;;
    host-tools)
      if curl -fsS -m 5 "http://127.0.0.1:5180/health" >/dev/null 2>&1; then
        echo "  ✅ host-tools: /health 応答 (:5180)"; ok=$((ok+1))
      else
        echo "  ❌ host-tools: /health 無応答 (:5180)"; fail=$((fail+1))
      fi
      ;;
    containers)
      # kill 直後は spawn されていなくて正常 (次受信で起動)。情報表示のみ。
      n=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c '^nanoclaw-v2-' || true)
      echo "  ℹ️  containers: 現在稼働数=$n (0 でも正常 — 次受信で再 spawn)"
      ;;
  esac
done

echo; echo "[restart-nanoclaw] done: $ok ok, $fail failed"
[ "$fail" -gt 0 ] && exit 1; exit 0
```

## 注意事項

### 自セッション巻き込み

このスキルは host 側 operator 専用。`host` を kickstart すると、nanoclaw コンテナ経由で
動いている session は再起動の影響を受けるため、**コンテナ越しからは実行しない**。

### isbtty/deshi#416 の反映粒度

| 変更 | 反映に必要な操作 |
|---|---|
| ③A (`container/agent-runner/src/providers/claude.ts`) | `containers` 再 spawn のみ (build 不要) |
| ③B (deshi `.deshi/nanoclaw-delegation.md`) | group 再 spawn 時に daemon `/nanoclaw-fragment` から再取得 → `containers` 再 spawn |
| host src (`src/**`) 変更 | `host` build + kickstart |

つまり #416 の nanoclaw 側コード反映は通常 **`/deshi-restart-nanoclaw containers`** で足りる。

### kickstart で復旧しない場合

`launchctl bootout gui/$UID/<label>` → `launchctl bootstrap gui/$UID <plist>` の
load サイクルが必要。ログは `${REPO_ROOT}/logs/` 配下を確認。

## 関連

- Issue: isbtty/deshi#416
- Issue: isbtty/deshi#523 — Step 4.5 (OneCLI Gateway 整合) の契機。SDK メジャー更新で
  サーバが `/api/*` のまま取り残され `ensureAgent` が 404 → spawn 失敗 (typing 固着) した障害
- ADR-0016 (`restart` 動詞追加) — 本スキルの命名根拠
- `src/install-slug.ts` — host label 動的生成
- `setup/launchd/com.isbtty.nanoclaw.host-tools.plist` — host-tools launchd
- deshi `.claude/skills/deshi-restart-services/` — deshi 側 (別スキル・据え置き)
