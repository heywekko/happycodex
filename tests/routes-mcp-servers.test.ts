import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-routes-mcp-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: process.env.HAPPYCLAW_TEST_DATA_DIR!,
  };
});

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'admin',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/billing.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    checkMcpServerLimit: () => ({ allowed: true }),
  };
});

const mcpServersRoutesModule = await import('../src/routes/mcp-servers.js');
const mcpServersRoutes = mcpServersRoutesModule.default;

beforeEach(() => {
  if (fs.existsSync(SHARED_TMP)) {
    for (const entry of fs.readdirSync(SHARED_TMP)) {
      fs.rmSync(path.join(SHARED_TMP, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(SHARED_TMP, { recursive: true });
  }
});

afterEach(() => {
  if (!fs.existsSync(SHARED_TMP)) return;
  for (const entry of fs.readdirSync(SHARED_TMP)) {
    fs.rmSync(path.join(SHARED_TMP, entry), { recursive: true, force: true });
  }
});

describe('mcp servers routes', () => {
  test('POST / stores enabled HTTP server config for the current user', async () => {
    const res = await mcpServersRoutes.request('/', {
      method: 'POST',
      body: JSON.stringify({
        id: 'context7',
        type: 'http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer test' },
        description: 'Docs',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server).toMatchObject({
      id: 'context7',
      enabled: true,
      type: 'http',
      url: 'https://mcp.example.test',
      headers: { Authorization: 'Bearer test' },
    });

    const serversPath = path.join(
      SHARED_TMP,
      'mcp-servers',
      'alice',
      'servers.json',
    );
    const file = JSON.parse(fs.readFileSync(serversPath, 'utf-8'));
    expect(file.servers.context7).toMatchObject({
      enabled: true,
      type: 'http',
      url: 'https://mcp.example.test',
      headers: { Authorization: 'Bearer test' },
    });
  });

  test('POST /sync-host imports MCP servers from host Codex config', async () => {
    const home = path.join(SHARED_TMP, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.context7]',
        'url = "https://mcp.example.test"',
        'http_headers = { Authorization = "Bearer test" }',
        '',
        '[mcp_servers.playwright]',
        'command = "npx"',
        'args = ["@playwright/mcp@latest"]',
        '',
        '[mcp_servers.playwright.env]',
        'BROWSER = "chromium"',
        '',
      ].join('\n'),
    );

    try {
      const res = await mcpServersRoutes.request('/sync-host', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ added: 2, updated: 0, deleted: 0, skipped: 0 });

      const serversPath = path.join(
        SHARED_TMP,
        'mcp-servers',
        'alice',
        'servers.json',
      );
      const file = JSON.parse(fs.readFileSync(serversPath, 'utf-8'));
      expect(file.servers.context7).toMatchObject({
        enabled: true,
        syncedFromHost: true,
        type: 'http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer test' },
      });
      expect(file.servers.playwright).toMatchObject({
        enabled: true,
        syncedFromHost: true,
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        env: { BROWSER: 'chromium' },
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
