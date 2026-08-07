---
name: boswell-route-approvals-to-channel
description: 承認/許可通知(未知sender・channel招待・知識スコープ編集リンク)を owner/admin 個人 DM ではなく共有 Slack チャンネルに集約する配線スキル。配信時に user_roles を引き直すライブ判定方式。owner/admin が同じチャンネルで共同承認できるようにする (project)
user-invocable: true
allowed-tools: Bash, Read, AskUserQuestion
---

# `/boswell-route-approvals-to-channel` — 承認通知を共有チャンネルに集約

## 概要

承認/許可の通知（未知 sender 承認・channel 招待承認・知識スコープ編集リンク）を、
owner/admin **個人の DM** ではなく **共有 Slack チャンネル**に出す。owner と admin が
同じチャンネルで手の空いた人が承認ボタンを押して**共同対応**できるようにする。

### 仕組み

配線は `deshi_approvals_channel` テーブルに**設定として 1 行**書くだけ。実際の振り替えは
配信のたびに `resolve-override.ts` が `user_roles` を引き直して行う（`ensureUserDm` 冒頭）。

**配線と grant の順序は問わない。** 配線後に admin を付与した人にも自動的に効き、revoke
すれば自動的に個人 DM 解決へ戻る（boswell#712。旧方式は配線時点の owner/admin にしか
効かないスナップショットで、後から付与した admin のカードが個人 DM に埋もれる事故を起こした）。

承認ボタンは `hasAdminPrivilege` で認可されるので、チャンネルにいる admin なら誰が押しても通る。

### 前提

- Slack channel が導入済み（`/add-slack` 済み）。**Slack 単一が前提**（1 channel_type = 1 共有チャンネル）。
- このスキルは **nanoclaw host 上（Mac mini）で operator が実行**する。
- admin の付与はいつでもよい（先でも後でも）。`/boswell-manage-nanoclaw-admins grant` を使う。

### ⚠️ トレードオフ（実行前に owner に一言）

承認カードだけでなく、**approver 宛の host 起点通知すべて**が共有チャンネルに出る:
知識スコープ編集リンク（HMAC・1回限り・`channel-scope-link.ts`）/ チャンネル登録の完了通知 /
reject 理由の入力プロンプト。特に編集リンクは**チャンネル参加者の誰でも先に踏める**。
しかも**今後 admin を付与した人すべてに効く**ので、参加者の管理はより重要になる。
→ **「owner/admin だけの Slack チャンネル」**であることを必ず確認してから配線する。

配線ヘルパは作成する共有 mg に `denied_at` を立てて、router の channel 登録
escalation（`agentCount===0 && isMention`）を殺す。よってこのチャンネルで bot を
@mention しても「登録するか？」カードは出ない。ただし **既存チャンネルを転用した場合は
その mg の属性を変更しない**ので、必ず**専用の新規チャンネル**を作ること（業務用チャンネルの
ID を渡すと承認カードがそこに混ざる）。

## 手順

### 1. 共有チャンネルを用意して channel ID を取る

owner に「owner/admin だけが入る Slack チャンネル」を作ってもらう（例: `#nanoclaw-承認`）。

**チャンネル ID の調べ方（この案内文をユーザーに表示する）:**

> 📋 **チャンネル ID の確認方法**
> 1. Slack で対象チャンネルを開き、上部の**チャンネル名をクリック**
> 2. 開いたポップアップを一番下までスクロール
> 3. 「**チャンネル ID**」の値をコピー（`C` から始まる英数字、例: `C01ABCDEF`）
>
> （別の取り方: そのチャンネルのリンクを「リンクをコピー」で取得すると、URL 末尾の
> `/archives/C01ABCDEF` の `C...` 部分がチャンネル ID）

`AskUserQuestion` 等で **チャンネル ID だけ**（`C...`）をチャットから受け取り、あわせて
「**owner/admin 専用チャンネルか**」を必ず確認する。

### 2. 配線を実行（冪等）

受け取ったチャンネル ID をそのまま渡す（プレフィックス等は不要）:

```bash
pnpm exec tsx src/deshi/approvals-channel/run.ts C01ABCDEF --name "承認"
```

出力で以下を確認:
- `messaging_group_id ... (新規作成 / 既存を再利用)`
- `掃除した user_dms : N 行` ← 旧スナップショット方式の残骸（初回配線なら 0）
- `現時点の対象 (N) : slack:Uxxx, ...` ← **参考値**。実際の対象は配信のたびに判定されるので、
  この後に admin を付与した人も自動的に共有チャンネルに出る
- 末尾の user_dms 一覧に `⚠️ 共有 mg を指したまま` が出ていないこと（出たら掃除漏れ）

### 3. 実機検証（ゴール基準）

- [ ] 未登録 sender を Slack から発生させ、**承認カードが共有チャンネルに1枚出る**
- [ ] owner でない admin がボタンを押して**承認が通る**（`hasAdminPrivilege`）
- [ ] 承認後、対象 sender が `agent_group_members` に追加され再ルートされる
- [ ] **配線の後に admin を 1 名 grant** し、その人が先頭 approver になってもカードが
      共有チャンネルに出る（boswell#712 の回帰確認）
- [ ] **普通の DM 会話は従来通り**（別ユーザーで DM して応答が元 DM に返る）

## ロールバック

共有チャンネルへの配線を解除して個人 DM に戻す:

```bash
pnpm exec tsx src/deshi/approvals-channel/run.ts --clear
```

設定行を消すだけで override は即座に効かなくなり、以降のカードは個人 DM に戻る
（`user_dms` は配線時に掃除済みなので、次回の cold DM で個人 DM が解決し直される）。
共有チャンネルの messaging_group 行は残しても無害（参照されなくなるだけ）。

## 関連

- 配線ヘルパ: `src/deshi/approvals-channel/wire.ts` / CLI: `run.ts`
- 配信時のライブ判定: `src/deshi/approvals-channel/resolve-override.ts`
- 権限管理（誰が承認できるか）: `/boswell-manage-nanoclaw-admins`
- 設計: isbtty/deshi#517（初版）, isbtty/boswell#712（ライブ判定への移行）
- ADR-0019（deshi 所有テーブルと `ensureUserDm` 侵襲の例外）
