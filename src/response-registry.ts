/**
 * Response handler + shutdown callback registries.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * or `onShutdown()` at import time don't hit a TDZ error on the const-array
 * declarations. index.ts imports src/modules/index.js for its side effects,
 * which triggers module registrations that would otherwise happen before
 * index.ts's own const initializers have run.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/**
 * Outcome of dispatching a button-click response, returned up to the channel
 * bridge so it can update the card AFTER authorization has run (deshi#531).
 *
 * - `card: 'apply'` — authorized (or non-gated card): show the selected label
 *   and remove the buttons (the pre-#531 optimistic behavior).
 * - `card: 'keep'`  — rejected: leave the card actionable so the real approver
 *   can still click. `notify`, if set, is posted to the channel as a visible
 *   message (intentionally not ephemeral — the whole channel should see who
 *   tried and that it was refused).
 */
export interface ActionOutcome {
  card: 'apply' | 'keep';
  notify?: string;
}

/**
 * A response handler returns:
 * - `false` — not this handler's question (try the next handler).
 * - `true` — claimed; the card applies (default success behavior).
 * - `ActionOutcome` — claimed, with explicit control over the card update
 *   (e.g. reject → `{ card: 'keep', notify }`).
 */
export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean | ActionOutcome>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

type ShutdownCallback = () => void | Promise<void>;
const shutdownCallbacks: ShutdownCallback[] = [];

export function onShutdown(cb: ShutdownCallback): void {
  shutdownCallbacks.push(cb);
}

export function getShutdownCallbacks(): readonly ShutdownCallback[] {
  return shutdownCallbacks;
}
