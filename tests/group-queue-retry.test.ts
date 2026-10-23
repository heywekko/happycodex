import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { GroupQueue } from '../src/group-queue.js';

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 1,
    maxConcurrentHostProcesses: 1,
  }),
}));
vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const JID = 'wechat:test';
const RETRY_DELAYS = [5_000, 10_000, 20_000, 40_000, 80_000];

async function exhaustRetries(queue: GroupQueue): Promise<void> {
  queue.enqueueMessageCheck(JID);
  await vi.advanceTimersByTimeAsync(0);
  for (const delay of RETRY_DELAYS) {
    await vi.advanceTimersByTimeAsync(delay);
  }
}

describe('GroupQueue bounded retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('polling respects backoff and exhaustion without consuming pending messages', async () => {
    const queue = new GroupQueue();
    const processMessages = vi.fn(async () => false);
    const onExhausted = vi.fn();
    queue.setProcessMessagesFn(processMessages);
    queue.setOnMaxRetriesExceeded(onExhausted);

    queue.enqueueMessageCheck(JID);
    await vi.advanceTimersByTimeAsync(0);
    expect(processMessages).toHaveBeenCalledTimes(1);

    queue.enqueueMessageCheck(JID);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(processMessages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processMessages).toHaveBeenCalledTimes(2);
    for (const delay of RETRY_DELAYS.slice(1)) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(processMessages).toHaveBeenCalledTimes(6);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith(JID);
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.getStatus().groups).toContainEqual(
      expect.objectContaining({
        jid: JID,
        active: false,
        pendingMessages: true,
      }),
    );

    for (let i = 0; i < 3; i++) queue.enqueueMessageCheck(JID);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(processMessages).toHaveBeenCalledTimes(6);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('task completion and waiting-group drains cannot bypass exhaustion', async () => {
    const queue = new GroupQueue();
    const processMessages = vi.fn(async () => false);
    queue.setProcessMessagesFn(processMessages);
    await exhaustRetries(queue);
    expect(processMessages).toHaveBeenCalledTimes(6);

    // A task in the same group invokes drainGroup when it finishes.
    const task = vi.fn(async () => {});
    queue.enqueueTask(JID, 'same-group-task', task);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    expect(processMessages).toHaveBeenCalledTimes(6);

    // A different queue reaches exhaustion just as another group takes the
    // freed capacity. The failed group is left waiting with only messages;
    // completion of the other task must not restart it via drainWaiting.
    const waitingQueue = new GroupQueue();
    const waitingMessages = vi.fn(async () => false);
    waitingQueue.setProcessMessagesFn(waitingMessages);
    let finishTask!: () => void;
    waitingQueue.setOnContainerExit((jid) => {
      if (jid === JID && waitingMessages.mock.calls.length === 6) {
        waitingQueue.enqueueTask(
          'web:other',
          'other-task',
          () =>
            new Promise<void>((resolve) => {
              finishTask = resolve;
            }),
        );
      }
    });
    await exhaustRetries(waitingQueue);
    expect(waitingQueue.getStatus().waitingGroupJids).toContain(JID);
    finishTask();
    await vi.advanceTimersByTimeAsync(0);
    expect(waitingMessages).toHaveBeenCalledTimes(6);
    expect(waitingQueue.getStatus().groups).toContainEqual(
      expect.objectContaining({
        jid: JID,
        active: false,
        pendingMessages: true,
      }),
    );
  });

  test('new incoming messages explicitly reset the retry budget and success clears it', async () => {
    const queue = new GroupQueue();
    const processMessages = vi.fn(async () => false);
    const onExhausted = vi.fn();
    queue.setProcessMessagesFn(processMessages);
    queue.setOnMaxRetriesExceeded(onExhausted);
    await exhaustRetries(queue);

    processMessages.mockResolvedValueOnce(true);
    queue.enqueueMessageCheck(JID, { resetRetries: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(processMessages).toHaveBeenCalledTimes(7);
    expect(queue.getStatus().groups).toContainEqual(
      expect.objectContaining({
        jid: JID,
        active: false,
        pendingMessages: false,
      }),
    );
    expect(vi.getTimerCount()).toBe(0);

    // A successful run clears exhaustion and the notification marker, so a
    // subsequent independent failure receives a fresh bounded retry budget.
    await exhaustRetries(queue);
    expect(processMessages).toHaveBeenCalledTimes(13);
    expect(onExhausted).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('thrown processing errors use the same bounded retry budget', async () => {
    const queue = new GroupQueue();
    const processMessages = vi.fn(async () => {
      throw new Error('runner failed before final answer');
    });
    const onExhausted = vi.fn();
    queue.setProcessMessagesFn(processMessages);
    queue.setOnMaxRetriesExceeded(onExhausted);
    await exhaustRetries(queue);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(processMessages).toHaveBeenCalledTimes(6);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('explicit restart recovers an exhausted group', async () => {
    const queue = new GroupQueue();
    const processMessages = vi.fn(async () => false);
    queue.setProcessMessagesFn(processMessages);
    await exhaustRetries(queue);

    processMessages.mockResolvedValueOnce(true);
    await queue.restartGroup(JID);
    await vi.advanceTimersByTimeAsync(0);
    expect(processMessages).toHaveBeenCalledTimes(7);
    expect(queue.getStatus().groups).toContainEqual(
      expect.objectContaining({ jid: JID, active: false, pendingMessages: false }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  test('context overflow skips automatic retries and preserves recovery', async () => {
    const queue = new GroupQueue();
    const processMessages = vi.fn(async () => {
      queue.markContextOverflow(JID);
      return false;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck(JID);
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueueMessageCheck(JID);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(processMessages).toHaveBeenCalledTimes(1);
    expect(queue.getStatus().groups).toContainEqual(
      expect.objectContaining({ jid: JID, active: false, pendingMessages: true }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
