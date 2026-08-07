#!/usr/bin/env bash
#
# inject-launchd-env.sh — deshi host-tools 用 env を nanoclaw 本体 plist に注入する
# post-install ヘルパ (macOS のみ)。
#
# 【2026-06 更新】通常このスクリプトは不要です。
#   `fetchDeshiDelegationFragment` に `.env` fallback (readEnvFile) を入れたため、
#   launchd host は plist に env が無くても process.cwd()/.env から DESHI_DAEMON_* を
#   読みます (host の WorkingDirectory はプロジェクトルート)。本スクリプトは plist
#   レベルで env を固定したい人向けの任意ヘルパとして残しています。
#
# 背景 (歴史的経緯):
#   以前は `composeGroupClaudeMd` → `fetchDeshiDelegationFragment` が host プロセスから
#   `process.env.DESHI_DAEMON_DEVICE_SECRET` を直読みし、dotenv fallback が無かった。
#   一方 `bash nanoclaw.sh` (= `setup/auto.ts` → `setup/service.ts` → `setupLaunchd`)
#   が生成する `~/Library/LaunchAgents/com.nanoclaw-v2-<slug>.plist` の
#   EnvironmentVariables には PATH / HOME しか入らない。launchd-spawned プロセスは
#   user の interactive shell env を継承しないため、 `.env` に
#   `DESHI_DAEMON_*` を書いても plist 経由では届かず、
#   "DESHI_DAEMON_DEVICE_SECRET is not set on host" warning が出続け、
#   agent container は deshi delegation fragment 無しで起動する
#   (= mcp__deshi__daemon_gog を知らない agent になる)。
#
# 本スクリプト:
#   `bash nanoclaw.sh` 後に手で 1 回走らせると、
#   `.env` から `DESHI_DAEMON_URL` / `DESHI_DAEMON_DEVICE_SECRET` を読んで
#   plist の EnvironmentVariables に plutil 経由で merge する。idempotent。
#   secret を書き込んだ場合は chmod 600 で他ユーザから保護。
#   最後に launchctl bootout + bootstrap で reload。
#
# 使い方:
#   cd ~/code/nanoclaw
#   bash .deshi/scripts/inject-launchd-env.sh
#
# 終了コード:
#   0 = 成功 (差分 OR 差分無しの idempotent skip)
#   1 = 致命的エラー (plist 不在 / .env 不在 / plutil 失敗 / 必須キー欠落 等)
#
# 影響:
#   upstream (nanocoai/nanoclaw) のファイルには触らない。
#   読み: `.env`, `~/Library/LaunchAgents/<label>.plist`
#   書き: 同 plist の EnvironmentVariables、 chmod、 launchctl reload。

set -euo pipefail

# .deshi/scripts/ から見て project root は親の親
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export PROJECT_ROOT

# install-slug.sh は launchd_label() を提供する
# shellcheck source=../../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"

LABEL="$(launchd_label)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
ENV_FILE="$PROJECT_ROOT/.env"

if [[ ! -f "$PLIST" ]]; then
  echo "ERROR: launchd plist not found at $PLIST" >&2
  echo "  Run \`bash nanoclaw.sh\` (= setup:auto) first to generate it." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found" >&2
  echo "  Create it with DESHI_DAEMON_URL and DESHI_DAEMON_DEVICE_SECRET" >&2
  echo "  per the boswell-add-host-tools skill (deshi repo)." >&2
  exit 1
fi

# .env から 1 行ずつ key=value を取り、quotes を剥がして echo
# (POSIX awk なので macOS 標準でも動く)
read_env_value() {
  local key="$1"
  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      sub(/^[[:space:]]+/, "", $1)
      if ($1 != key) next
      # 残りを再結合 (= が値に含まれてもよい)
      val = $2
      for (i = 3; i <= NF; i++) val = val "=" $i
      # surrounding quotes を剥がす
      if (val ~ /^".*"$/) val = substr(val, 2, length(val) - 2)
      else if (val ~ /^'\''.*'\''$/) val = substr(val, 2, length(val) - 2)
      print val
      exit
    }
  ' "$ENV_FILE"
}

URL="$(read_env_value DESHI_DAEMON_URL || true)"
SECRET="$(read_env_value DESHI_DAEMON_DEVICE_SECRET || true)"

if [[ -z "$URL" && -z "$SECRET" ]]; then
  echo "ERROR: neither DESHI_DAEMON_URL nor DESHI_DAEMON_DEVICE_SECRET found in $ENV_FILE" >&2
  echo "  Nothing to inject." >&2
  exit 1
fi

# plutil -replace は存在/不在を問わず set してくれる (= idempotent)。
# EnvironmentVariables dict が既にある (= 初回 setup 後なら必ずある) 前提。
echo "Injecting DESHI_* env into ${LABEL}.plist"

if [[ -n "$URL" ]]; then
  plutil -replace 'EnvironmentVariables.DESHI_DAEMON_URL' -string "$URL" "$PLIST"
  echo "  set EnvironmentVariables.DESHI_DAEMON_URL"
fi

if [[ -n "$SECRET" ]]; then
  plutil -replace 'EnvironmentVariables.DESHI_DAEMON_DEVICE_SECRET' -string "$SECRET" "$PLIST"
  echo "  set EnvironmentVariables.DESHI_DAEMON_DEVICE_SECRET"
  # 秘密が入ったので 600 に絞る (boswell-add-host-tools skill の host-tools plist
  # と同じ convention)。
  chmod 600 "$PLIST"
fi

# plist syntax 検証 (壊れていないか)
plutil -lint "$PLIST" >/dev/null

# Reload: bootout してから bootstrap し、 plist の env 変更を確実に反映する。
# (kickstart -k だけだと old plist が cache されたまま再起動する事例あり)
UID_NUM="$(id -u)"
SVC="gui/${UID_NUM}/${LABEL}"

if launchctl print "$SVC" >/dev/null 2>&1; then
  launchctl bootout "$SVC" 2>/dev/null || true
  sleep 1
fi
launchctl bootstrap "gui/${UID_NUM}" "$PLIST"

# 反映確認
sleep 2
if launchctl list | awk -v l="$LABEL" '$3 == l { print $1 }' | grep -q '^[0-9]'; then
  echo "OK: ${LABEL} reloaded"
else
  echo "WARN: ${LABEL} did not come up — inspect launchctl print $SVC and logs/nanoclaw.error.log" >&2
  exit 1
fi
