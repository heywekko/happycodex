import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-routes-skills-'));
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
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    getEffectiveExternalDir: () =>
      path.join(process.env.HAPPYCLAW_TEST_DATA_DIR!, 'external-claude'),
  };
});

const skillsRoutesModule = await import('../src/routes/skills.js');
const skillsRoutes = skillsRoutesModule.default;

beforeEach(() => {
  process.env.HAPPYCLAW_TEST_USER_ROLE = 'member';
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

describe('skills routes', () => {
  test('GET / includes external host skills for admins', async () => {
    process.env.HAPPYCLAW_TEST_USER_ROLE = 'admin';
    fs.mkdirSync(
      path.join(SHARED_TMP, 'external-claude', 'skills', 'external-skill'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        SHARED_TMP,
        'external-claude',
        'skills',
        'external-skill',
        'SKILL.md',
      ),
      ['---', 'name: External Skill', 'description: Host skill', '---', ''].join('\n'),
    );

    const res = await skillsRoutes.request('/', { method: 'GET' });

    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const body = await res.json();
    expect(body.skills).toContainEqual(
      expect.objectContaining({
        id: 'external-skill',
        name: 'External Skill',
        source: 'external',
      }),
    );
  });

  test('GET /search with an empty query returns an empty search result list', async () => {
    const res = await skillsRoutes.request('/search', { method: 'GET' });

    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const body = await res.json();
    expect(body).toEqual({ results: [] });
  });

  test('GET /search/detail without lookup parameters returns null detail', async () => {
    const res = await skillsRoutes.request('/search/detail', { method: 'GET' });

    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const body = await res.json();
    expect(body).toEqual({ detail: null });
  });

  test('POST /install validates the package field before installing', async () => {
    const res = await skillsRoutes.request('/install', {
      method: 'POST',
      body: JSON.stringify({ package: 123 }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(400);
    if (res.status !== 400) return;
    const body = await res.json();
    expect(body).toEqual({ error: 'package field must be string' });
  });
});
