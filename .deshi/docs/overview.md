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
| `/deshi-add-host-tools` | container 内 agent が host 側を叩くための MCP bridge を agent group に追加 (`mcp__deshi__*` namespace) | agent group ごとに 1 回 |

`mcp__deshi__*` 系 tool の命名規則は [docs/mcp-tool-naming.md](mcp-tool-naming.md) を参照。

## ディレクトリ配置 (要点)

```
isbtty/nanoclaw/
├── .claude/skills/
│   ├── add-slack/                       ← Tier A (upstream、触らない)
│   ├── deshi-update-from-upstream/      ← Tier B Operational
│   ├── deshi-update-nanoclaw-official-channels/
│   └── deshi-add-host-tools/            ← Tier B Feature (host-tools MCP bridge)
│
├── src/deshi/                           ← deshi 専有 namespace (host 側)
│   ├── index.ts
│   ├── channels/index.ts                ← deshi channels barrel (将来用)
│   ├── providers/index.ts               ← deshi providers barrel (将来用)
│   ├── host-tools-server.ts             ← container ↔ host bridge の dispatcher
│   ├── host-tools/                      ← handler 群 (health 他)
│   │   ├── index.ts                     ← handler barrel
│   │   └── health.ts
│   └── lib/                             ← (必要に応じて)
│
├── container/skills/
│   ├── welcome/                         ← Tier A
│   ├── deshi-add-host-tools/            ← Tier B (MCP stdio スクリプト)
│   │   └── deshi-mcp-stdio.ts
│   └── deshi-*/                         ← Tier B (prefix 必須、将来追加分)
│
├── setup/launchd/                       ← Tier B (host 側 launchd plist テンプレート)
│   └── com.isbtty.nanoclaw.host-tools.plist
│
└── .deshi/                              ← メタディレクトリ
    ├── upstream-versions.json           ← Tier A pin
    ├── skills-catalog.json              ← deshi Skill カタログ
    ├── CHANGELOG.md
    ├── adr/                             ← ADR 置き場
    ├── docs/                            ← 設計方針・運用ドキュメント
    │   ├── overview.md                  ← このファイル
    │   ├── design.md                    ← 詳細設計
    │   ├── mcp-tool-naming.md           ← MCP tool 命名規則
    │   └── merge-driver-setup.md        ← merge driver 登録手順
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
