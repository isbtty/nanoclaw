# ADR-0008: upstream 追従の base を merge-base(main, channels) にする

- Status: accepted
- Date: 2026-05-01
- Refs: isbtty/deshi#126, isbtty/deshi#128, isbtty/deshi#189, isbtty/deshi#199

## Context

`isbtty/nanoclaw` は `nanocoai/nanoclaw` を fork した運用リポジトリ。

upstream の構造として、`upstream/channels` は `upstream/main` の直系子孫ではなく、両者は分岐したまま並行進化している (`upstream/channels` 側で main を forward-merge する運用は不定期)。このため `upstream/main` HEAD を直接取り込むと:

1. `/deshi-update-nanoclaw-official-channels` の ancestor チェックが通らず、channels の同期に進めない
2. main HEAD まで取り込んだ commit のうち、まだ channels 側に取り込まれていない変更が deshi に先行混入し、channels 取り込み時の整合性検証が困難になる

過去 (dou-id/nanoclaw-deshi 時代) には、この問題を「`upstream.main.sha` を main HEAD ではなく共通祖先に手動で書き換える」ことで一時回避していた。しかしこれは Skill レベルでの実装が伴っておらず、毎回手動介入が必要で、運用が回らなかった。

## Decision

`/deshi-update-from-upstream` の **default 取り込み対象を `git merge-base upstream/main upstream/channels` (共通祖先) に変更する**。

- Skill 内で `upstream/main` HEAD・`upstream/channels` HEAD・共通祖先の 3 SHA を計算し、preview に明示
- merge 対象は共通祖先 (`TARGET_SHA`)
- `.deshi/upstream-versions.json` の `upstream.main.sha` には共通祖先を記録、新規フィールド `upstream.main.policy` を追加して `"merge-base"` (default) または `"target"` (`--target` 明示指定時) を区別
- `--target <ref>` で明示指定したい場合はエスケープハッチとして残す (channels の祖先でない ref を指定した場合は warn / abort)
- tag は本 Skill 内で一切参照しない (`upstream.main.tag` フィールドも書かない、`git describe` も呼ばない)
- `/deshi-update-nanoclaw-official-channels` の ancestor チェックは「`upstream.main.sha` が `upstream/channels` の祖先か」を sanity check する位置付けに変更 (共通祖先運用なら定義上必ず通る)

## Consequences

### Positive

- `/deshi-update-from-upstream` を実行するだけで共通祖先まで自動的に追従できる (手動介入不要)。
- `upstream.main.sha` は常に `upstream/channels` の祖先になるため、後段の channels skill が abort しない。
- 安定性を損なう「main HEAD だけ先行する状態」が原理的に発生しない。
- `install-official-channels.sh` の差分計算 base が「真の共通祖先」になり、channels 固有の変更だけを純粋に抽出できる。

### Trade-offs (受容)

- **main HEAD が前進しても共通祖先が動かなければ No-op になる**: `upstream/channels` 側で main の forward-merge が起きるまで、deshi 側に main の改善が取り込まれない。
- `upstream.main.tag` フィールドは null (or 未使用)。共通祖先に tag が付いていることは稀で、tag による追従は Skill ではサポートしない。
- 共通祖先が後退するエッジケース (upstream の force-push 等) は基本想定しない。発生時は `--target` で明示指定して凌ぐ。

### Migration

- 既存の `upstream-versions.json` (`upstream.main.policy` が無い) は `legacy` として扱う。次回 Skill 実行時に自動的に `merge-base` policy で書き換わる。
- schemaVersion は 1 のまま据え置き (`policy` フィールドは optional 扱い)。

## Alternatives considered

1. **main HEAD 追従 + channels 取り込み時に必要分だけ rebase する**: rebase の機械化が困難で、衝突解決が複雑化する。
2. **upstream に PR を出して channels を main の直系子孫にしてもらう**: 上流コントロール外。upstream の運用方針に踏み込むのは現実的でない。
3. **channels 取り込み時に内部で merge-base を都度計算する**: Skill 間で計算ロジックが重複し、`upstream.main.sha` の意味が曖昧になる。

## See also

- isbtty/deshi#126 (基準コミット見直し議論)
- isbtty/deshi#128 (本 ADR の直接トリガー)
- 実装: `.claude/skills/deshi-update-from-upstream/SKILL.md`、`.claude/skills/deshi-update-nanoclaw-official-channels/SKILL.md`、`.deshi/scripts/install-official-channels.sh`
