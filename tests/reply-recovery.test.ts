import { describe, expect, test, vi } from 'vitest';
import {
  deliverPendingReply,
  readPendingReply,
  savePendingReply,
  type PendingReply,
} from '../src/reply-recovery.js';

function fixture() {
  const rows = new Map<string, string>();
  const store = {
    get: (key: string) => rows.get(key),
    set: (key: string, value: string) => {
      rows.set(key, value);
    },
    remove: (key: string) => {
      rows.delete(key);
    },
  };
  const reply: PendingReply = {
    messageId: 'answer-1',
    cursor: { timestamp: '2026-10-23T01:00:00Z', id: 'input-1' },
    text: 'saved answer',
    localImagePaths: [],
    attempts: 0,
    status: 'pending',
  };
  savePendingReply(store, 'wechat:test', reply);
  return { store, reply };
}

describe('durable IM reply recovery', () => {
  test('retries the saved answer after a restart without generating another answer', async () => {
    const { store, reply } = fixture();
    const commit = vi.fn();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider rejected'))
      .mockResolvedValue(undefined);
    expect(
      await deliverPendingReply(store, 'wechat:test', { send, commit }),
    ).toBe('retry');
    expect(commit).not.toHaveBeenCalled();
    expect(readPendingReply(store, 'wechat:test')?.error).toBe(
      'provider rejected',
    );
    // A newly constructed store facade sees only the persisted JSON after restart.
    expect(
      await deliverPendingReply({ ...store }, 'wechat:test', { send, commit }),
    ).toBe('delivered');
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every(
        ([item]) =>
          item.messageId === reply.messageId && item.text === reply.text,
      ),
    ).toBe(true);
    expect(commit).toHaveBeenCalledExactlyOnceWith(reply.cursor);
    expect(readPendingReply(store, 'wechat:test')).toBeUndefined();
  });

  test('stops delivery retries at the durable limit and preserves the failure and answer', async () => {
    const { store } = fixture();
    const send = vi.fn().mockRejectedValue(new Error('prepare failed'));
    const commit = vi.fn();
    for (let i = 0; i < 6; i++)
      await deliverPendingReply(store, 'wechat:test', { send, commit });
    for (let i = 0; i < 10; i++) {
      expect(
        await deliverPendingReply({ ...store }, 'wechat:test', {
          send,
          commit,
        }),
      ).toBe('blocked');
    }
    expect(send).toHaveBeenCalledTimes(6);
    expect(commit).not.toHaveBeenCalled();
    expect(readPendingReply(store, 'wechat:test')).toMatchObject({
      status: 'blocked',
      attempts: 6,
      error: 'prepare failed',
      text: 'saved answer',
    });
  });

  test('a fresh incoming message allows retry with refreshed channel context', async () => {
    const { store, reply } = fixture();
    savePendingReply(store, 'wechat:test', {
      ...reply,
      status: 'blocked',
      attempts: 6,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn();
    expect(
      await deliverPendingReply(store, 'wechat:test', {
        send,
        commit,
        hasNewInput: true,
      }),
    ).toBe('delivered');
    expect(commit).toHaveBeenCalledExactlyOnceWith(reply.cursor);
  });

  test('a crash after delivery before cursor commit does not resend the reply', async () => {
    const { store, reply } = fixture();
    const send = vi.fn().mockResolvedValue(undefined);
    await expect(
      deliverPendingReply(store, 'wechat:test', {
        send,
        commit: () => {
          throw new Error('crash before cursor commit');
        },
      }),
    ).rejects.toThrow('crash before cursor commit');
    expect(readPendingReply(store, 'wechat:test')?.status).toBe('delivered');
    const commit = vi.fn();
    await deliverPendingReply(store, 'wechat:test', { send, commit });
    expect(send).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledExactlyOnceWith(reply.cursor);
  });

  test('another chat cannot consume this reply', async () => {
    const { store } = fixture();
    const send = vi.fn();
    const commit = vi.fn();
    expect(
      await deliverPendingReply(store, 'wechat:other', { send, commit }),
    ).toBe('empty');
    expect(send).not.toHaveBeenCalled();
    expect(readPendingReply(store, 'wechat:test')).toBeDefined();
  });
});
