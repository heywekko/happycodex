import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { syncCodexMcpConfig } from '../src/codex-mcp-config.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-codex-mcp-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeWorkspaceSettings(settings: unknown): string {
  const workspaceRoot = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(workspaceRoot, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2),
  );
  return workspaceRoot;
}

describe('syncCodexMcpConfig', () => {
  test('writes enabled workspace MCP servers into isolated Codex config', () => {
    const workspaceRoot = writeWorkspaceSettings({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless'],
          env: { BROWSER: 'chromium' },
        },
        context7: {
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer test' },
        },
      },
    });
    const codexHome = path.join(tmp, 'codex-home');

    const result = syncCodexMcpConfig({ codexHome, workspaceRoot });

    expect(result.syncedServers).toBe(2);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(config).toContain('[mcp_servers.playwright]');
    expect(config).toContain('command = "npx"');
    expect(config).toContain('args = ["@playwright/mcp@latest", "--headless"]');
    expect(config).toContain('[mcp_servers.playwright.env]');
    expect(config).toContain('BROWSER = "chromium"');
    expect(config).toContain('[mcp_servers.context7]');
    expect(config).toContain('url = "https://mcp.example.test"');
    expect(config).toContain('http_headers = { Authorization = "Bearer test" }');
  });

  test('replaces previous managed MCP block while preserving other config', () => {
    const workspaceRoot = writeWorkspaceSettings({ mcpServers: {} });
    const codexHome = path.join(tmp, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model = "gpt-5"',
        '# BEGIN HAPPYCODEX MCP SERVERS',
        '[mcp_servers.old]',
        'command = "old"',
        '# END HAPPYCODEX MCP SERVERS',
        '',
      ].join('\n'),
    );

    const result = syncCodexMcpConfig({ codexHome, workspaceRoot });

    expect(result.syncedServers).toBe(0);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(config).toContain('model = "gpt-5"');
    expect(config).not.toContain('mcp_servers.old');
    expect(config).not.toContain('HAPPYCODEX MCP SERVERS');
  });

  test('merges enabled user MCP servers before workspace settings', () => {
    const workspaceRoot = writeWorkspaceSettings({
      mcpServers: {
        shared: { command: 'workspace-shared' },
      },
    });
    const codexHome = path.join(tmp, 'codex-home');

    const result = syncCodexMcpConfig({
      codexHome,
      workspaceRoot,
      userMcpServers: {
        global_docs: {
          url: 'https://global.example.test',
          headers: { Authorization: 'Bearer global' },
        },
        shared: {
          command: 'global-shared',
        },
      },
    });

    expect(result.syncedServers).toBe(2);
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(config).toContain('[mcp_servers.global_docs]');
    expect(config).toContain('url = "https://global.example.test"');
    expect(config).toContain('http_headers = { Authorization = "Bearer global" }');
    expect(config).toContain('[mcp_servers.shared]');
    expect(config).toContain('command = "workspace-shared"');
    expect(config).not.toContain('global-shared');
  });
});
