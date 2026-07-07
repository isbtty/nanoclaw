// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// The `channels` branch keeps this file fully populated — it's the
// fully-loaded, runnable branch. Individual `/add-<channel>` skills pull
// single files from this branch onto a user's install, appending their
// own import lines to a leaner barrel on main.
//
// deshi 運用: installed[] (.deshi/upstream-versions.json) の全 channel を
// active に保つ。import は registry 登録のみで接続副作用は無く (認証未設定なら
// factory が null を返す)、installed[] と barrel-active を一致させる方針。

// cli — default channel that ships with main (always on, no credentials).
import './cli.js';

// discord
import './discord.js';

// slack
import './slack.js';

// telegram
import './telegram.js';

// github
import './github.js';

// linear
import './linear.js';

// google chat
import './gchat.js';

// microsoft teams
import './teams.js';

// whatsapp cloud api
import './whatsapp-cloud.js';

// resend (email)
import './resend.js';

// matrix — deshi 無効化: @beeper/chat-adapter-matrix@0.2.0 が matrix-js-sdk の
// 内部モジュールを拡張子なし ESM import で参照し import 時にクラッシュするため、
// barrel で有効化すると host boot / 全 barrel test を道連れに落とす。upstream で
// adapter が修正されたら有効化する (.deshi/scripts/install-official-channels.sh の
// DESHI_BARREL_DISABLED も参照)。
// import './matrix.js';

// webex
import './webex.js';

// wechat
import './wechat.js';

// imessage
import './imessage.js';

// gmail (native, no Chat SDK)

// whatsapp (native, no Chat SDK)
import './whatsapp.js';

// signal (native, no Chat SDK — signal-cli TCP JSON-RPC daemon)
// import './signal.js';

// emacs (native HTTP bridge, no Chat SDK)
// import './emacs.js';

// deltachat (native, no Chat SDK)
// import './deltachat.js'

// deshi 固有 channel adapter (LINE 等) — barrel 1 行ルール (ADR-0005)
import './deshi.js';
