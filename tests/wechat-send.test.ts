import { afterEach, describe, expect, test, vi } from 'vitest';

import { createWeChatConnection } from '../src/wechat.js';

describe('WeChat connection and send failures', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('rejects text sends when no context token is available', async () => {
    const connection = createWeChatConnection({
      botToken: 'test-token',
      ilinkBotId: 'test-bot',
    });

    await expect(
      connection.sendMessage('unknown-user', 'hello'),
    ).rejects.toThrow('No context_token available');
  });

  test('restores a persisted context token for sends after restart', async () => {
    const fetchMock = vi.fn(async () => ({
      text: async () => '{"ret":0}',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const connection = createWeChatConnection({
      botToken: 'test-token',
      ilinkBotId: 'test-bot',
      contextTokens: { 'known-user': 'persisted-context' },
    });

    await connection.sendMessage('known-user', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).msg.context_token).toBe(
      'persisted-context',
    );
  });

  test('reports the connection unhealthy after repeated poll failures', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error('socket reset');
    });
    vi.stubGlobal('fetch', fetchMock);

    const connection = createWeChatConnection({
      botToken: 'test-token',
      ilinkBotId: 'test-bot',
    });
    await connection.connect({ onNewChat: () => {} });

    await vi.advanceTimersByTimeAsync(0);
    expect(connection.isConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(connection.isConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(connection.isConnected()).toBe(false);

    await connection.disconnect();
  });
});
