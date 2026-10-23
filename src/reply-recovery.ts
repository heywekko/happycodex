import type { MessageCursor, MessageSourceKind } from './types.js';

export const PENDING_REPLY_PREFIX = 'pending_im_reply:';
const MAX_DELIVERY_ATTEMPTS = 6;

export interface PendingReply {
  ownerId?: string;
  groupFolder?: string;
  messageId: string;
  cursor: MessageCursor;
  text: string;
  localImagePaths: string[];
  messageMeta?: {
    turnId?: string;
    sessionId?: string;
    sdkMessageUuid?: string;
    sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
    finalizationReason?: 'completed' | 'interrupted' | 'error';
  };
  attempts: number;
  status: 'pending' | 'delivered' | 'blocked';
  error?: string;
}

interface ReplyStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function readPendingReply(
  store: ReplyStore,
  jid: string,
): PendingReply | undefined {
  const raw = store.get(PENDING_REPLY_PREFIX + jid);
  if (!raw) return undefined;
  // Invalid durable state must block processing rather than regenerate an answer.
  const reply = JSON.parse(raw) as PendingReply;
  if (
    !reply.messageId ||
    !reply.cursor?.id ||
    !reply.cursor.timestamp ||
    !reply.text ||
    !Array.isArray(reply.localImagePaths) ||
    !Number.isInteger(reply.attempts) ||
    reply.attempts < 0 ||
    !['pending', 'delivered', 'blocked'].includes(reply.status)
  ) {
    throw new Error('Invalid pending IM reply; retained for recovery');
  }
  return reply;
}

export function savePendingReply(
  store: ReplyStore,
  jid: string,
  reply: PendingReply,
): void {
  store.set(PENDING_REPLY_PREFIX + jid, JSON.stringify(reply));
}

export function queuePendingReply(store: ReplyStore, jid: string, reply: PendingReply): void {
  if (readPendingReply(store, jid)) {
    throw new Error('An earlier generated IM reply is still awaiting delivery');
  }
  savePendingReply(store, jid, reply);
}

/** The answer is durable before the first send. Recovery never invokes a model. */
export async function deliverPendingReply(
  store: ReplyStore,
  jid: string,
  options: {
    send(reply: PendingReply): Promise<void>;
    commit(cursor: MessageCursor): void;
    hasNewInput?: boolean;
  },
): Promise<'empty' | 'delivered' | 'retry' | 'blocked'> {
  const reply = readPendingReply(store, jid);
  if (!reply) return 'empty';
  if (reply.status === 'blocked') {
    if (!options.hasNewInput) return 'blocked';
    reply.status = 'pending';
    reply.attempts = 0;
  }
  if (reply.status !== 'delivered') {
    reply.attempts++;
    savePendingReply(store, jid, reply);
    try {
      await options.send(reply);
    } catch (error) {
      reply.error = error instanceof Error ? error.message : String(error);
      reply.status =
        reply.attempts >= MAX_DELIVERY_ATTEMPTS ? 'blocked' : 'pending';
      savePendingReply(store, jid, reply);
      return reply.status === 'blocked' ? 'blocked' : 'retry';
    }
    reply.status = 'delivered';
    delete reply.error;
    savePendingReply(store, jid, reply);
  }
  // Commit before deleting the receipt: a restart here commits without resending.
  options.commit(reply.cursor);
  store.remove(PENDING_REPLY_PREFIX + jid);
  return 'delivered';
}
