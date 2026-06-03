import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happycodex-sdk-query-test-'),
);
const fakeCodexPath = path.join(
  os.tmpdir(),
  'happycodex-fake-sdk-query-codex.js',
);

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

const { sdkQuery } = await import('../src/sdk-query.ts');

const fakeCodexScript = `#!/usr/bin/env node
const fs = require('fs');

if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN || process.env.CLAUDE_CONFIG_DIR) {
  console.error('host auth env leaked');
  process.exit(7);
}

const args = process.argv.slice(2);
const outputFlag = args.indexOf('--output-last-message');
const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : '';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(outputPath, JSON.stringify({
    args,
    codexHome: process.env.CODEX_HOME,
    prompt,
  }));
});
`;

describe('sdkQuery', () => {
  const previousCodexBin = process.env.CODEX_BIN;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousCodexApiKey = process.env.CODEX_API_KEY;
  const previousCodexAccessToken = process.env.CODEX_ACCESS_TOKEN;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    fs.writeFileSync(fakeCodexPath, fakeCodexScript, { mode: 0o755 });
    fs.rmSync(path.join(tmpRoot, 'sessions'), { recursive: true, force: true });
    process.env.CODEX_BIN = fakeCodexPath;
    process.env.OPENAI_API_KEY = 'host-key-must-not-leak';
    process.env.CODEX_API_KEY = 'host-codex-api-key-must-not-leak';
    process.env.CODEX_ACCESS_TOKEN = 'host-token-must-not-leak';
    process.env.CLAUDE_CONFIG_DIR = 'host-claude-dir-must-not-leak';
  });

  afterEach(() => {
    fs.rmSync(path.join(tmpRoot, 'sessions'), { recursive: true, force: true });
    fs.rmSync(fakeCodexPath, { force: true });
    if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBin;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousCodexApiKey;
    if (previousCodexAccessToken === undefined)
      delete process.env.CODEX_ACCESS_TOKEN;
    else process.env.CODEX_ACCESS_TOKEN = previousCodexAccessToken;
    if (previousClaudeConfigDir === undefined)
      delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  });

  test('uses the requested isolated Codex runtime home', async () => {
    const result = await sdkQuery('hello', {
      groupFolder: 'team-a',
      timeout: 3000,
    });

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed).toEqual({
      args: expect.arrayContaining(['--sandbox', 'read-only']),
      codexHome: path.join(tmpRoot, 'sessions', 'team-a', '.codex'),
      prompt: 'hello',
    });
    expect(parsed.args).not.toContain('--ask-for-approval');
    expect(
      fs.existsSync(path.join(tmpRoot, 'sessions', 'team-a', '.codex')),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(tmpRoot, 'sessions', 'team-a', '.codex', 'config.toml'),
        'utf8',
      ),
    ).toContain('cli_auth_credentials_store = "file"');
  });

  test('defaults to the main Codex runtime home', async () => {
    const result = await sdkQuery('legacy path', { timeout: 3000 });

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed).toEqual({
      args: expect.arrayContaining(['--sandbox', 'read-only']),
      codexHome: path.join(tmpRoot, 'sessions', 'main', '.codex'),
      prompt: 'legacy path',
    });
    expect(parsed.args).not.toContain('--ask-for-approval');
  });

  test('uses user-level Codex install when service PATH omits it', async () => {
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousCodexBinForTest = process.env.CODEX_BIN;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-home-'));
    const userBin = path.join(tmpHome, '.local', 'bin');
    const userCodex = path.join(userBin, 'codex');

    try {
      fs.mkdirSync(userBin, { recursive: true });
      fs.writeFileSync(
        userCodex,
        fakeCodexScript.replace('#!/usr/bin/env node', `#!${process.execPath}`),
        { mode: 0o755 },
      );
      process.env.HOME = tmpHome;
      process.env.PATH = '/usr/bin:/bin';
      delete process.env.CODEX_BIN;

      const result = await sdkQuery('fallback path', { timeout: 3000 });
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.prompt).toBe('fallback path');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCodexBinForTest === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousCodexBinForTest;
    }
  });
});
