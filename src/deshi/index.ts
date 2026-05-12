// isbtty/nanoclaw 固有のコードはこのディレクトリ配下に閉じ込める。
// upstream nanoclaw の src/ ファイルへの侵襲は import './deshi.js'; 1 行のみ。
// 詳細は ADR-0002 を参照。
import './channels/index.js';
import './providers/index.js';
