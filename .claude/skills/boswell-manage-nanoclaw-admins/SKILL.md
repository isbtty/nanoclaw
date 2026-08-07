---
name: boswell-manage-nanoclaw-admins
description: nanoclaw の承認権限を持つ管理者(グローバル admin)を増減する運用スキル。list / grant / revoke を ncl roles でラップ。承認申請を owner 以外にも分散対応させるための権限側の配線 (project)
user-invocable: true
allowed-tools: Bash, Read, AskUserQuestion
---

# `/boswell-manage-nanoclaw-admins` — 承認できる管理者の管理

## 概要

承認申請（未知 sender / channel 招待 / 知識スコープ等）に対応できる人を owner 1 人から
増やすための**権限管理**スキル。**グローバル admin**（`agent_group_id=NULL`、全 group 横断）を
`grant` / `list` / `revoke` する。

`/boswell-route-approvals-to-channel`（**どこに**カードを出すか）とは責務が別で、こちらは
**誰が**承認できるか。共有チャンネルにカードを出しても押せるのは owner/admin だけなので、
分散対応にはまず admin 付与が要る。

- **owner 実行前提**（admin 付与は owner の専権）。
- **admin ロールのみ**を touch する。owner ロールは触らない（revoke で owner を消さない）。
- このスキルは **nanoclaw host 上（Mac mini）で operator が実行**する。host 呼び出しは
  承認ゲートを bypass する（`dispatch.ts:118`）ので、その場で即反映される。

## サブコマンド

### `list` — 承認権を持つ人を一覧

owner と global admin を表示する。

```bash
ncl roles list
```

`role=owner`（消さない）と `role=admin, agent_group_id=NULL`（管理対象）を読み取って提示する。

### メンバー ID の入力（`slack:` は付けさせない）

ユーザーには **メンバー ID だけ**（`Uxxxxxxxx`）をチャットで入力してもらう。`slack:` プレフィックスは
このスキルが内部で付ける（`slack:` + 入力値）。ユーザーが `slack:Uxxxxxxxx` と付けて入力してきた場合も
そのまま受け付ける（二重付与しないよう、既に `slack:` で始まっていれば付け足さない）。

**Slack メンバー ID の調べ方（この案内文をユーザーに表示する）:**

> 📋 **メンバー ID の確認方法**
> 1. Slack で対象の人の**アイコンや名前をクリック**してプロフィールを開く
> 2. プロフィール右上（または名前の下）の「**⋮（その他）**」をクリック
> 3. 「**メンバー ID をコピー**」を選ぶ（`U` から始まる英数字、例: `U01ABCDEF`）
>
> （見当たらない場合: プロフィール下部の「詳細情報を表示」→「メンバー ID」）

### `grant` — admin を追加

1. 上の案内文を表示し、対象のメンバー ID を `AskUserQuestion` 等でチャットから受け取る。
2. `slack:` を前置して user_id を組み立てる（例: 入力 `U01ABCDEF` → `slack:U01ABCDEF`）。
3. users に未登録なら作成（表示名も分かれば確認して渡す）:
   ```bash
   ncl users create --id slack:U01ABCDEF --kind slack --display_name "<名前>"
   ```
4. グローバル admin を付与（`--group` を付けない = global。冪等: INSERT OR IGNORE）:
   ```bash
   ncl roles grant --user slack:U01ABCDEF --role admin
   ```

既知ユーザーから選ぶ場合は先に `ncl users list` で slack ユーザーを提示してよい。

### `revoke` — admin を外す

同様にメンバー ID だけをチャットから受け取り、`slack:` を前置して実行する:

```bash
ncl roles revoke --user slack:U01ABCDEF --role admin
```

`--group` は付けない（global admin を外す）。該当が無ければ `ncl` が `role not found` を返すので
「既に admin ではない」と伝えて握る。**owner は対象外**（`--role admin` 固定）。

## 運用フロー（2 スキルの組み合わせ）

- `/boswell-route-approvals-to-channel` … 通知先を共有 Slack チャンネルに配線（1 回だけ）
- `/boswell-manage-nanoclaw-admins grant` … 共同対応する人を admin 化

**順序は問わない。** 配線済みなら grant するだけでその人も共有チャンネル経由になる
（対象は配信のたびに `user_roles` から判定される。boswell#712）。再配線は不要。

## 関連

- 通知先の配線（どこに出すか）: `/boswell-route-approvals-to-channel`
- 承認者の列挙順: `pickApprover`（`src/modules/approvals/primitive.ts` — scoped→global→owner）
- 設計: isbtty/deshi#517, isbtty/boswell#712
