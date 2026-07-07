---
name: deshi-manage-nanoclaw-admins
description: nanoclaw の承認権限を持つ管理者(グローバル admin)を増減する運用スキル。list / grant / revoke を ncl roles でラップ。承認申請を owner 以外にも分散対応させるための権限側の配線 (project)
user-invocable: true
allowed-tools: Bash, Read, AskUserQuestion
---

# `/deshi-manage-nanoclaw-admins` — 承認できる管理者の管理

## 概要

承認申請（未知 sender / channel 招待 / 知識スコープ等）に対応できる人を owner 1 人から
増やすための**権限管理**スキル。**グローバル admin**（`agent_group_id=NULL`、全 group 横断）を
`grant` / `list` / `revoke` する。

`/deshi-route-approvals-to-channel`（**どこに**カードを出すか）とは責務が別で、こちらは
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

### `grant` — admin を追加

対象の Slack user ID (`Uxxxxxxxx`) を owner に確認する（`AskUserQuestion`）。
Slack user ID は Slack プロフィール → 「メンバー ID をコピー」で取得。

1. users に未登録なら作成:
   ```bash
   ncl users create --id slack:Uxxxxxxxx --kind slack --display_name "<名前>"
   ```
2. グローバル admin を付与（`--group` を付けない = global。冪等: INSERT OR IGNORE）:
   ```bash
   ncl roles grant --user slack:Uxxxxxxxx --role admin
   ```

既知ユーザーから選ぶ場合は先に `ncl users list` で slack ユーザーを提示してよい。

### `revoke` — admin を外す

```bash
ncl roles revoke --user slack:Uxxxxxxxx --role admin
```

`--group` は付けない（global admin を外す）。該当が無ければ `ncl` が `role not found` を返すので
「既に admin ではない」と伝えて握る。**owner は対象外**（`--role admin` 固定）。

## 運用フロー（2 スキルの組み合わせ）

1. `/deshi-manage-nanoclaw-admins grant` … 共同対応する人を admin 化
2. `/deshi-route-approvals-to-channel` … 通知先を共有 Slack チャンネルに配線
3. 以後、許可申請は共有チャンネルに1枚 → owner/admin の誰かが押して承認

## 関連

- 通知先の配線（どこに出すか）: `/deshi-route-approvals-to-channel`
- 承認者の列挙順: `pickApprover`（`src/modules/approvals/primitive.ts` — scoped→global→owner）
- 設計: isbtty/deshi#517
