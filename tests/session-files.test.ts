import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-session-'));

vi.mock('../src/config.js', () => ({
  DATA_DIR: tmpRoot,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER the mocks are registered so session-files picks up the mocked
// DATA_DIR at evaluation time.
const { clearSessionFiles } = await import('../src/session-files.ts');

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'sessions'), { recursive: true, force: true });
});

afterEach(() => {
  // no-op; tmpRoot kept for whole suite, subdirs scrubbed per-test
});

function touch(filePath: string, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('clearSessionFiles', () => {
  test('removes everything under .claude/ except settings.json', () => {
    const folder = 'main';
    const claudeDir = path.join(tmpRoot, 'sessions', folder, '.claude');
    const codexDir = path.join(tmpRoot, 'sessions', folder, '.codex');
    touch(path.join(claudeDir, 'settings.json'), '{"keep":true}');
    touch(path.join(claudeDir, 'projects', 'foo', '1.jsonl'), 'line');
    touch(path.join(claudeDir, 'debug', 'sdk.txt'), 'debug');
    touch(path.join(claudeDir, 'CLAUDE.md'), '# runtime');
    touch(path.join(codexDir, 'auth.json'), '{"keep":true}');
    touch(path.join(codexDir, 'config.toml'), 'model = "gpt-5"');
    touch(path.join(codexDir, 'sessions', '2026', '06', 'thread.jsonl'), 'line');

    clearSessionFiles(folder);

    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'debug'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(codexDir, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(codexDir, 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(codexDir, 'sessions'))).toBe(false);
  });

  test('agent-scoped clear only affects the given agent subdir', () => {
    const folder = 'main';
    const agentId = 'agent-xyz';
    const mainDir = path.join(tmpRoot, 'sessions', folder, '.claude');
    const agentDir = path.join(
      tmpRoot,
      'sessions',
      folder,
      'agents',
      agentId,
      '.claude',
    );
    const mainCodexDir = path.join(tmpRoot, 'sessions', folder, '.codex');
    const agentCodexDir = path.join(
      tmpRoot,
      'sessions',
      folder,
      'agents',
      agentId,
      '.codex',
    );
    touch(path.join(mainDir, 'projects', 'p.jsonl'));
    touch(path.join(agentDir, 'projects', 'a.jsonl'));
    touch(path.join(agentDir, 'settings.json'), '{}');
    touch(path.join(mainCodexDir, 'sessions', 'main.jsonl'));
    touch(path.join(agentCodexDir, 'auth.json'), '{}');
    touch(path.join(agentCodexDir, 'sessions', 'agent.jsonl'));

    clearSessionFiles(folder, agentId);

    expect(fs.existsSync(path.join(mainDir, 'projects', 'p.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(mainCodexDir, 'sessions', 'main.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(agentCodexDir, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(agentCodexDir, 'sessions'))).toBe(false);
  });

  test('clears Codex sessions even when the inherited .claude dir does not exist', () => {
    const folder = 'codex-only';
    const codexDir = path.join(tmpRoot, 'sessions', folder, '.codex');
    touch(path.join(codexDir, 'auth.json'), '{}');
    touch(path.join(codexDir, 'sessions', '2026', '06', 'thread.jsonl'), 'line');

    expect(() => clearSessionFiles(folder)).not.toThrow();
    expect(fs.existsSync(path.join(codexDir, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(codexDir, 'sessions'))).toBe(false);
  });

  test('no-op when runtime dirs do not exist', () => {
    expect(() => clearSessionFiles('never-created')).not.toThrow();
  });

  test('survives a broken symlink inside .claude/', () => {
    const folder = 'main';
    const claudeDir = path.join(tmpRoot, 'sessions', folder, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    touch(path.join(claudeDir, 'settings.json'));
    fs.symlinkSync(
      '/nonexistent/path/to/nowhere',
      path.join(claudeDir, 'stale-link'),
    );

    // Core guarantee: the per-entry try/catch means a problematic symlink
    // does NOT abort the whole reset — settings.json must survive regardless
    // of whether the symlink itself is cleanable on the current platform.
    expect(() => clearSessionFiles(folder)).not.toThrow();
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
  });
});
