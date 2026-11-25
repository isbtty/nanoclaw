/** Expected command failure with an additive machine result and process code. */
export class CliCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliCommandError';
  }
}
