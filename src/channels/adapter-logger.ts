import { log } from '../log.js';

/**
 * Logger shape expected by `@chat-adapter/*` adapters (the `Logger` interface
 * from the `chat` package). Adapters call `config.logger ?? new
 * ConsoleLogger("info")`, so when we don't inject one they fall back to their
 * own console logger and emit a line on *every* retry. A polling adapter
 * (e.g. Telegram) hitting intermittent network errors then floods the log
 * with thousands of identical "polling request failed" warnings, burying
 * genuine errors (#472).
 */
export interface AdapterLogger {
  child(prefix: string): AdapterLogger;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

interface RateState {
  windowStart: number;
  suppressed: number;
}

/** Coerce an adapter's variadic log args into nanoclaw's structured data shape. */
function toData(args: unknown[]): Record<string, unknown> | undefined {
  const first = args[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return first as Record<string, unknown>;
  }
  return args.length ? { args } : undefined;
}

/**
 * Build a `Logger` for a chat adapter that collapses repeated identical
 * messages into one line per `windowMs`, then a summary carrying how many
 * were suppressed. Distinct messages are never collapsed together, so real
 * errors still surface immediately — only the retry spam is throttled.
 *
 * Routes through nanoclaw's own `log` so adapter output is consistent with
 * the rest of the process instead of the adapter's bare ConsoleLogger.
 */
export function createAdapterLogger(name: string, windowMs = DEFAULT_WINDOW_MS): AdapterLogger {
  // Shared across child loggers so the same message under one adapter is
  // throttled as a unit. Keyed by logger name + level + message.
  const state = new Map<string, RateState>();

  function emit(loggerName: string, level: Level, message: string, args: unknown[]): void {
    const key = `${loggerName}:${level}:${message}`;
    const now = Date.now();
    const prev = state.get(key);
    if (!prev || now - prev.windowStart >= windowMs) {
      const data = toData(args);
      const out = prev && prev.suppressed > 0 ? { ...(data ?? {}), suppressedInWindow: prev.suppressed } : data;
      log[level](`[${loggerName}] ${message}`, out);
      state.set(key, { windowStart: now, suppressed: 0 });
    } else {
      prev.suppressed++;
    }
  }

  function make(loggerName: string): AdapterLogger {
    return {
      child: (prefix: string) => make(`${loggerName}:${prefix}`),
      debug: (message, ...args) => emit(loggerName, 'debug', message, args),
      info: (message, ...args) => emit(loggerName, 'info', message, args),
      warn: (message, ...args) => emit(loggerName, 'warn', message, args),
      error: (message, ...args) => emit(loggerName, 'error', message, args),
    };
  }

  return make(name);
}
