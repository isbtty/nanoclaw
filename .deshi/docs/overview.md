# isbtty/nanoclaw 全体像

このドキュメントは isbtty が運用する nanoclaw fork の **全体像** を示す。詳細設計は [design.md](design.md)、設計判断の正式記録は [adr/](../adr/)、議論の経緯は isbtty/deshi#98 を参照。

## Fork モデル

```
upstream: nanocoai/nanoclaw  (main + channels を追従)
    │
    │  /deshi-update-from-upstream
    │   └─ 内部で /deshi-update-nanoclaw-official-channels update を自動呼出
    ▼
isbtty/nanoclaw (main)                  ← Tier A + Tier B
    │  v0.X.Y tag 発行
    │
    │  git clone (運用環境)
    ▼
運用環境で動作
```

| 層 | リポジトリ | 含まれるもの | 管理者 |
|----|----------|------------|--------|
| **Tier A** | upstream `nanocoai/nanoclaw` | OSS 本体 (host + agent-runner + 公式 channel) | upstream community |
| **Tier B** | `isbtty/nanoclaw` | deshi 独自追加コード・Skill | @isbtty/deshi-core |

## 用意する Skill (deshi 独自)

| Skill | 何をするか | 頻度 |
|-------|-----------|------|
| `/deshi-update-from-upstream` | upstream main を deshi に取り込むラッパー (内部で channels skill を自動呼出) | 任意のタイミング |
| `/deshi-update-nanoclaw-official-channels` | `upstream/channels` から `installed` 配列の channel を一括再適用 | 上記から自動呼出 (単独実行も可) |

## ディレクトリ配置 (要点)

```
isbtty/nanoclaw/
├── .claude/skills/
│   ├── add-slack/                       ← Tier A (upstream、触らない)
│   ├── deshi-update-from-upstream/      ← Tier B Operational
│   └── deshi-update-nanoclaw-official-channels/
│
├── src/deshi/                           ← deshi 専有 namespace
│   ├── index.ts
│   ├── channels/index.ts                ← deshi channels barrel (将来用)
│   ├── providers/index.ts               ← deshi providers barrel (将来用)
│   └── lib/                             ← (必要に応じて)
│
├── container/skills/
│   ├── welcome/                         ← Tier A
│   └── deshi-*/                         ← Tier B (prefix 必須、将来追加分)
│
└── .deshi/                              ← メタディレクトリ
    ├── upstream-versions.json           ← Tier A pin
    ├── skills-catalog.json              ← deshi Skill カタログ
    ├── CHANGELOG.md
    ├── adr/                             ← ADR 置き場
    ├── docs/                            ← 設計方針・運用ドキュメント
    │   ├── overview.md                  ← このファイル
    │   └── design.md                    ← 詳細設計
    └── scripts/
        ├── install-official-channels.sh
        ├── merge-barrel.sh              ← git custom merge driver
        └── verify-layout.ts             ← CI 必須 (未実装)
```

## 運用サマリ

### 上流追従 (upstream → deshi)

1. `/deshi-update-from-upstream` を `isbtty/nanoclaw` で実行
2. 内部で `/deshi-update-nanoclaw-official-channels update` が自動呼出され、channels も同期される
3. validation 通過後、`v0.X.Y` tag が打たれる
4. `main` への push と PR 作成は人間判断 (Skill は sync branch までで止まる)

## 関連ドキュメント

- 詳細設計: [design.md](design.md)
- ADR 一覧: [adr/](../adr/)
- 議論の経緯: isbtty/deshi#98
