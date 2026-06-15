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
- ADR-0016 (`restart` 動詞追加) — 本スキルの命名根拠
- `src/install-slug.ts` — host label 動的生成
- `setup/launchd/com.isbtty.nanoclaw.host-tools.plist` — host-tools launchd
- deshi `.claude/skills/deshi-restart-services/` — deshi 側 (別スキル・据え置き)
