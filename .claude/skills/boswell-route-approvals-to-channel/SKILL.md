---
name: boswell-route-approvals-to-channel
description: 承認/許可通知(未知sender・channel招待・知識スコープ編集リンク)を owner/admin 個人 DM ではなく共有 Slack チャンネルに集約する配線スキル。user_dms リダイレクト方式でコア非改修。owner/admin が同じチャンネルで共同承認できるようにする (project)
user-invocable: true
allowed-tools: Bash, Read, AskUserQuestion
---

# `/boswell-route-approvals-to-channel` — 承認通知を共有チャンネルに集約

## 概要

承認/許可の通知（未知 sender 承認・channel 招待承認・知識スコープ編集リンク）を、
owner/admin **個人の DM** ではなく **共有 Slack チャンネル**に出す。owner と admin が
同じチャンネルで手の空いた人が承認ボタンを押して**共同対応**できるようにする。

**コア非改修**（案D: `user_dms` リダイレクト、deshi#517）。upstream 追従コンフリクト無し。

### 仕組み（1 行）

owner/admin の `user_dms` 行を共有チャンネルの messaging_group に向けるだけ。host の
`ensureUserDm(approver)` はキャッシュを `is_group` 無検証で返すのでカードがそのチャンネルに
出る。承認ボタンは `hasAdminPrivilege` で認可されるので誰が押しても通る。

### 前提

- **admin 権限の付与が先**（チャンネルに出ても押せるのは owner/admin だけ）。
  未付与なら先に `/boswell-manage-nanoclaw-admins grant` で admin を揃える。
- Slack channel が導入済み（`/add-slack` 済み）。deshi#517 は **Slack 単一が前提**。
- このスキルは **nanoclaw host 上（Mac mini）で operator が実行**する。

### ⚠️ トレードオフ（実行前に owner に一言）

知識スコープ編集リンク（HMAC・1回限り・`channel-scope-link.ts`）も同じ `user_dms` 経由
なので、**このリンクも共有チャンネルに出る**。チャンネル参加者の誰でも先に踏める。
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
- `redirected (N) : slack:Uxxx, ...` ← owner/admin が共有チャンネルに向いた
- `skipped (...)` ← slack identity でない owner/admin（Slack 単一運用では通常空）
- 末尾の `--- 現在の user_dms ---` で各 approver が `[GROUP <CHANNEL_ID>]` を指しているか

`redirected` が空なら → owner/admin に `slack:Uxxx` identity が無い。
`/boswell-manage-nanoclaw-admins grant` で slack identity 付きの admin を用意してから再実行。

### 3. 実機検証（ゴール基準）

- [ ] 未登録 sender を Slack から発生させ、**承認カードが共有チャンネルに1枚出る**
- [ ] owner でない admin がボタンを押して**承認が通る**（`hasAdminPrivilege`）
- [ ] 承認後、対象 sender が `agent_group_members` に追加され再ルートされる
- [ ] **普通の DM 会話は従来通り**（別ユーザーで DM して応答が元 DM に返る）

## ロールバック

共有チャンネルへの配線を解除して個人 DM に戻す:

```bash
# 該当 approver の user_dms 行を削除 → 次回 ensureUserDm が openDM で個人DMを再解決する
pnpm exec tsx scripts/q.ts data/v2.db \
  "DELETE FROM user_dms WHERE channel_type='slack' AND messaging_group_id='<共有MG_ID>'"
```

共有チャンネルの messaging_group 行は残しても無害（参照されなくなるだけ）。

## 関連

- 配線ヘルパ: `src/deshi/approvals-channel/wire.ts` / CLI: `run.ts`
- 権限管理（誰が承認できるか）: `/boswell-manage-nanoclaw-admins`
- 設計: isbtty/deshi#517
