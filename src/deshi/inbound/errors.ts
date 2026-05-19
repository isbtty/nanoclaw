/**
 * inbound HTTP receivers の共通エラー型。
 *
 * handler 内部で「どの HTTP status で応答すべきか」を表現するために投げる
 * 例外。host-tools-server.ts の dispatch (`dispatchInbound`) がこの型を
 * 検知して `status` をそのまま HTTP response の status code に伝える。
 * それ以外の例外は dispatch 側で 500 に包まれる。
 *
 * 命名規則は ADR-0010 (kebab-case の direct HTTP receiver 系統)。
 * inbound 配下のすべての handler から共有される基盤クラスなので、
 * 個別 handler ファイル (例: `skill-execution-notifications.ts`) ではなく
 * 本ファイルに切り出している。
 */
export class InboundHandlerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'InboundHandlerError';
  }
}
