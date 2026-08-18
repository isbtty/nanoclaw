/**
 * Sender extraction from a raw inbound payload.
 *
 * Leaf module: no DB writes, no module registration. Both the sender resolver
 * (which upserts the `users` row) and interceptors that run *before* sender
 * resolution — the reject-with-reason capture — need the same parse, and an
 * interceptor can't import `permissions/index.ts` without a cycle.
 */
import type { InboundEvent } from '../../channels/adapter.js';

export interface ParsedSender {
  /** Namespaced user id (`<channelType>:<handle>`), or null when the payload carries no sender. */
  userId: string | null;
  /** Display name when the payload carries one. */
  senderName: string | null;
}

export function parseSender(event: InboundEvent): ParsedSender {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return { userId: null, senderName: null };
  }

  // chat-sdk-bridge serializes author info as a nested `author.userId` and
  // does NOT populate top-level `senderId`. Older adapters (v1, native) put
  // `senderId` or `sender` directly at the top level. Check all three.
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? author.userId : undefined;
  const senderName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? author.fullName : undefined) ??
    (typeof author?.userName === 'string' ? author.userName : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return { userId: null, senderName: senderName ?? null };

  const userId = rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`;
  return { userId, senderName: senderName ?? null };
}
