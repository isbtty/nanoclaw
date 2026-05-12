# ADR-0005: barrel 衝突は merge driver + src/deshi/index.ts パターンで解決する

- Status: accepted
- Date: 2026-04-28
- Refs: isbtty/deshi#98

## Context

upstream の barrel ファイル (`src/channels/index.ts`、`src/providers/index.ts`) は新しい channel / provider が追加されるたびに `import './<name>.js';` 行が追加される。deshi が独自 channel を加えるとここで衝突しやすい。手動解決を毎回するのは運用負荷が高い。

## Decision

upstream の barrel ファイルには **`import './deshi.js';` の単一行のみ**を追加する。deshi の追加 import は `src/deshi/channels/index.ts` (および `src/deshi/providers/index.ts`) で管理する。

```typescript
// src/channels/index.ts (upstream 管理)
import './cli.js';
import './slack.js';
import './deshi.js';           // deshi の唯一のエントリ

// src/channels/deshi.ts (deshi 管理、1行)
import '../deshi/channels/index.js';

// src/deshi/channels/index.ts (deshi 管理、自由に追記)
import './line.js';
```

衝突しうる行は upstream barrel ファイルの「deshi.js を import する1行」のみに局所化する。これに対して以下の自動解決を CI / merge 時に適用する:

- `.gitattributes` で対象ファイルに `merge=deshi-barrel` を指定
- `.deshi/scripts/merge-barrel.sh` を custom merge driver として登録 (union merge を実行)

## Consequences

- upstream の barrel が増えても、deshi 側で衝突するのは1行だけで、それも自動 union merge で解決される。
- `src/deshi/channels/index.ts` 等は upstream merge では絶対に衝突しない (upstream は `src/deshi/**` を触らない)。
- 開発者は新 channel 追加時、`src/deshi/channels/index.ts` への 1 行追記だけで完結する。
- merge driver の登録は各開発者の `~/.gitconfig` に記録する必要がある (CI / Skill 内で自動セットアップする手段は別途検討)。

## See also

- 詳細議論: isbtty/deshi#98 (本文「barrel 衝突対策」セクション)
- namespace ルール: ADR-0002
- 衝突解決 Skill: `.claude/skills/deshi-update-from-upstream/SKILL.md`
