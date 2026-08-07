/**
 * inbound HTTP receivers の handler barrel。
 *
 * MCP 経由で呼ばれる host-tools/ (snake_case + `deshi_` prefix) とは別系統で、
 * 外部システム (deshi daemon 等) からの直接 HTTP push を受け付ける。
 * 命名規則は ADR-0010 (kebab-case) を参照。
 *
 * 認証は host-tools-server.ts の dispatch 側で一括検証する (Bearer
 * <BOSWELL_DAEMON_DEVICE_SECRET>、timingSafeEqual)。本 barrel に登録する
 * handler は認証済みリクエストを処理する前提。
 *
 * 新規 inbound handler を追加するときは:
 *   1. `src/deshi/inbound/<resource>.ts` を作る (kebab-case)
 *   2. ハンドラ関数を `<resource>Handler` (camelCase) 命名で export
 *   3. ここに `inboundHandlers['<resource>'] = <resource>Handler` を追加
 *   4. handler 内で `InboundHandlerError` を throw すると dispatch が
 *      適切な status + body で応答する。それ以外の例外は 500 になる。
 */

import { skillExecutionNotificationsHandler } from './skill-execution-notifications.js';

export type InboundHandler = (body: unknown) => Promise<unknown>;

export const inboundHandlers: Record<string, InboundHandler> = {};

inboundHandlers['skill-execution-notifications'] = skillExecutionNotificationsHandler as InboundHandler;
