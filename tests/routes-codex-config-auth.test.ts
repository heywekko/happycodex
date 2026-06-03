import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/im-channel.js', () => ({
  getChannelType: () => null,
}));

const configRoutesModule = await import('../src/routes/config.js');
const configRoutes = configRoutesModule.default;

describe('codex config route auth', () => {
  test.each([
    ['GET', '/codex/status'],
    ['PUT', '/codex/settings'],
    ['PUT', '/codex/api-key'],
    ['POST', '/codex/browser-auth/start'],
    ['GET', '/codex/browser-auth/test-login-id'],
    ['POST', '/codex/browser-auth/test-login-id/cancel'],
    ['POST', '/codex/device-auth/start'],
    ['GET', '/codex/device-auth/test-login-id'],
    ['POST', '/codex/device-auth/test-login-id/cancel'],
    ['POST', '/codex/logout'],
  ])(
    '%s %s requires authentication before permission checks',
    async (method, path) => {
      const res = await configRoutes.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    },
  );
});
