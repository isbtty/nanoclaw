# launchd env injection (deshi 用)

> **【2026-06 更新】この手動ステップは通常不要になりました。**
> `fetchDeshiDelegationFragment` に `.env` fallback (`readEnvFile`) を入れたため、
> launchd host は plist に env が無くても `process.cwd()/.env` から
> `DESHI_DAEMON_*` を直接読みます (host の `WorkingDirectory` は
> `setup/service.ts:setupLaunchd` がプロジェクトルートに設定済み)。
> 下記スクリプトは **plist レベルで env を固定したい人向けの任意ヘルパ**として残します。
> 背景は [`src/deshi/fetch-delegation-fragment.ts`](../../src/deshi/fetch-delegation-fragment.ts) の JSDoc を参照。

## 何のため (歴史的経緯)

以前は `composeGroupClaudeMd` → `fetchDeshiDelegationFragment` が host プロセスから
`process.env.DESHI_DAEMON_DEVICE_SECRET` を**直読み**し、**dotenv fallback が無かった**。
deshi daemon 側 `GET /nanoclaw-fragment` の Bearer 認証に使う値。

`bash nanoclaw.sh` (= `setup/auto.ts` → `setup/service.ts` → `setupLaunchd`)
が生成する `~/Library/LaunchAgents/com.nanoclaw-v2-<slug>.plist` の
`EnvironmentVariables` には **PATH と HOME しか入らない**。launchd-spawned
プロセスは user の interactive shell env を継承しないため、 `.env` に
`DESHI_DAEMON_*` を書いても plist 経由では届かなかった。

結果として `bash nanoclaw.sh` 後に nanoclaw のログには:

```
WARN  fetchDeshiDelegationFragment failed; no cached mcp-deshi.md available
err: Error: DESHI_DAEMON_DEVICE_SECRET is not set on host
```

が出続け、 agent container は deshi delegation fragment 無しで起動した
(= `mcp__deshi__daemon_gog` を知らない agent になり、 GitHub issue 依頼や
Google Calendar 質問で OneCLI の接続フローに誘導されてしまう)。

→ **`.env` fallback の追加でこの症状は解消**。以下のスクリプトは plist 固定派向けの任意手段。

## (任意) plist に env を固定したい場合

`.deshi/scripts/inject-launchd-env.sh` を走らせると plist の
`EnvironmentVariables` に `DESHI_DAEMON_*` を merge できる:

```bash
cd ~/code/nanoclaw
bash .deshi/scripts/inject-launchd-env.sh   # 任意。fallback があるので通常は不要
```

スクリプトは:

1. `setup/lib/install-slug.sh` を source して現 install の plist (`com.nanoclaw-v2-<slug>.plist`) を当てる
2. `.env` から `DESHI_DAEMON_URL` / `DESHI_DAEMON_DEVICE_SECRET` を読む
3. `plutil -replace EnvironmentVariables.<KEY>` で plist に merge (idempotent)
4. secret を書き込んだ場合は `chmod 600` で他ユーザから保護 (`boswell-add-host-tools` skill の host-tools plist と同 convention)
5. `plutil -lint` で構文検証
6. `launchctl bootout` + `launchctl bootstrap` で reload して反映を実証

`.env` に `DESHI_DAEMON_*` が無い場合は exit 1 + ヒント表示で止まる
(= 「黙って何もしない」 ではなく明示的に失敗する)。

## なぜ upstream (setup/service.ts) には手を入れないか

deshi 固有の依存 (`DESHI_DAEMON_DEVICE_SECRET` 含めて) を upstream の
`setup/service.ts` に持ち込むと、 nanocoai/nanoclaw 側の generic な
service setup ロジックに deshi 専用 branch が混ざる。これは isbtty fork が
継続的に upstream と sync する運用 ([.deshi/upstream-versions.json](../upstream-versions.json))
と相性が悪く、 merge conflict 面を増やす。

代わりに `.deshi/scripts/install-official-channels.sh` や
`.deshi/scripts/merge-barrel.sh` と同じく **deshi side の post-install ヘルパ**
として外付けする方が、 責務境界が綺麗 (`.deshi/` 配下は deshi 固有の追加で
upstream に存在しない) で upstream 追従コストもゼロ。

## 関連

- [install-official-channels.sh](../scripts/install-official-channels.sh) — 同じく `.deshi/scripts/` パターンの post-install ヘルパ
- [`/boswell-add-host-tools` skill (deshi repo)](https://github.com/isbtty/deshi/blob/main/.claude/skills/boswell-add-host-tools/SKILL.md) — DESHI_DAEMON_DEVICE_SECRET を `.env` に書く前段ステップ
- [`setup/service.ts`](../../setup/service.ts) — plist を初期生成する upstream ステップ (本スクリプトはこの後で plist を merge する)
