# ADR 0017: upstream b6cb53e の BREAKING を取り込む

- Status: proposed
- Date: 2026-07-06
- Upstream range: 3601a8a1febb6ec16391099981c533798a203e3e..b6cb53e (upstream/main HEAD)
- Target policy: target (--target upstream/main)
- Related: isbtty/deshi#523 (crashLoop→respawn 誤apology 修正のための upstream 追従)
- Detected commits:
  - `e734e5c feat(upgrade): startup tripwire + upgrade marker`
  - `092487d chore: release 2.1.0; guard auto-bump against deliberate version changes`

## Context

upstream nanocoai/nanoclaw 3601a8a..b6cb53e (306 commits) のロールアップに以下 2 件の `[BREAKING]` が含まれる。

### 1. e734e5c — startup upgrade tripwire (本命の BREAKING)

- 起動時 step 0.5(DB init 前)で `enforceUpgradeTripwire` が走り、install が **正規経路(setup / update / migrate)を通って現行 version に到達したか**を検証する。
- marker は `data/upgrade-state.json`。**marker が missing / corrupt / version mismatch なら fail-closed で host が起動拒否**。
- 生の `git pull` で migration を飛ばした install は「silently broken」ではなく loudly fail する設計。
- 追加ファイル: `src/upgrade-state.ts`(marker + getCodeVersion + isUpgradeCurrent + enforceUpgradeTripwire), `src/index.ts`(step 0.5 で gate), `scripts/upgrade-state.ts`(get/set CLI = override/recovery コマンド), `setup/service.ts` / update・migrate skill が成功時に stamp。

### 2. 092487d — release 2.1.0 + auto-bump ガード

- package.json を 2.1.0 に。tripwire が package.json version を source of truth にするため同梱。
- `bump-version.yml` が「push 済み commit が自分で package.json を変えていれば auto-bump を skip」するよう変更(deliberate な 2.1.0 を 2.1.1 に上げないため)。低リスク。

## Decision

**a. 取り込む**(案X フル追従の一部として b6cb53e ごと取り込む)。

理由: 本追従の目的は #523 の spurious-kill 修正(`a806534` justWoke gate、この 306 commit に含まれる)を入れること。tripwire は付随して入るが、下記 Consequences の手当てで運用可能。skip すると tripwire だけ除外するための cherry-pick 除外が必要になり、306 commit の追従の意義(全体追従)を損なう。

## Consequences

deshi install(Mac mini daemon)への影響と必須手当て:

- **⚠️ マージ後・デプロイ前に upgrade marker を必ず stamp すること。** 今回の到達経路は upstream sync であって setup/update/migrate skill ではないため、marker が無いまま起動すると `enforceUpgradeTripwire` が fail-closed で daemon 起動拒否する。
  - recovery/override コマンド: `pnpm exec tsx scripts/upgrade-state.ts set`(現行 code version で marker を書く)。
  - デプロイ手順に「build → marker stamp → service restart」を組み込む必要がある。README/運用 doc への追記候補。
- package.json version が 2.0.x → 2.1.0 にジャンプ。deshi tag(`deshi.currentTag`)とは別系統。
- `bump-version.yml` は upstream CI 用。isbtty fork の CI に影響ないか要確認(fork では通常 disabled)。
- この 306 commit には #523 本命の `a806534`(justWoke grace gate)を含む。追従の主目的はこれ。
