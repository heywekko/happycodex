import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-workspace-skills-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/db.js', () => ({
  getRegisteredGroup: () => ({
    jid: 'chat:team',
    name: 'Team',
    folder: 'team',
    added_at: '2026-06-02T00:00:00.000Z',
    executionMode: 'container',
    created_by: 'alice',
    is_home: false,
  }),
}));

vi.mock('../src/web-context.js', () => ({
  canAccessGroup: () => true,
}));

const workspaceConfigRoutesModule = await import('../src/routes/workspace-config.js');
const workspaceConfigRoutes = workspaceConfigRoutesModule.default;

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

describe('workspace skill routes', () => {
  test('POST /workspace-config/skills/install validates package format before installing', async () => {
    const res = await workspaceConfigRoutes.request(
      '/chat%3Ateam/workspace-config/skills/install',
      {
        method: 'POST',
        body: JSON.stringify({ package: 'not a package' }),
        headers: { 'Content-Type': 'application/json' },
      },
    );

    expect(res.status).toBe(400);
    if (res.status !== 400) return;
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid package name format' });
  });
});

describe('workspace MCP routes', () => {
  test('POST /workspace-config/mcp-servers writes enabled HTTP server settings', async () => {
    const res = await workspaceConfigRoutes.request(
      '/chat%3Ateam/workspace-config/mcp-servers',
      {
        method: 'POST',
        body: JSON.stringify({
          id: 'context7',
          type: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer test' },
          description: 'Docs',
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server).toMatchObject({
      id: 'context7',
      enabled: true,
      type: 'http',
      url: 'https://mcp.example.test',
      headers: { Authorization: 'Bearer test' },
    });

    const settingsPath = path.join(
      SHARED_TMP,
      'groups',
      'team',
      '.claude',
      'settings.json',
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.mcpServers.context7).toEqual({
      type: 'http',
      url: 'https://mcp.example.test',
      headers: { Authorization: 'Bearer test' },
    });
  });
});
