import fs from 'fs';
import path from 'path';

const BEGIN_MARKER = '# BEGIN HAPPYCODEX MCP SERVERS';
const END_MARKER = '# END HAPPYCODEX MCP SERVERS';

interface CodexMcpServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  headers?: unknown;
  url?: unknown;
}

interface WorkspaceSettings {
  mcpServers?: unknown;
}

export interface SyncCodexMcpConfigOptions {
  codexHome: string;
  userMcpServers?: Record<string, Record<string, unknown>>;
  workspaceRoot?: string;
}

export interface SyncCodexMcpConfigResult {
  syncedServers: number;
  configPath: string;
}

function readWorkspaceSettings(workspaceRoot: string | undefined): WorkspaceSettings {
  if (!workspaceRoot) return {};
  const filePath = path.join(workspaceRoot, '.claude', 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as WorkspaceSettings;
  } catch {
    return {};
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === 'string');
  return result.length > 0 ? result : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function quoteTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : quoteTomlString(value);
}

function renderStringArray(values: string[]): string {
  return `[${values.map(quoteTomlString).join(', ')}]`;
}

function renderInlineStringTable(record: Record<string, string>): string {
  return `{ ${Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${quoteTomlKey(key)} = ${quoteTomlString(value)}`)
    .join(', ')} }`;
}

function stripManagedBlock(config: string): string {
  const pattern = new RegExp(
    `\\n?${BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'g',
  );
  return config.replace(pattern, '\n').trimEnd();
}

function asMcpServers(value: unknown): Record<string, CodexMcpServer> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, CodexMcpServer>
    : {};
}

function renderManagedBlock(servers: Record<string, CodexMcpServer>): { text: string; count: number } {
  const lines: string[] = [];
  let count = 0;

  for (const [id, server] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) continue;

    const url = typeof server.url === 'string' ? server.url.trim() : '';
    const command = typeof server.command === 'string' ? server.command.trim() : '';
    if (!url && !command) continue;

    const table = `mcp_servers.${quoteTomlKey(id)}`;
    lines.push(`[${table}]`);
    if (url) {
      lines.push(`url = ${quoteTomlString(url)}`);
      const headers = asStringRecord(server.headers);
      if (headers) lines.push(`http_headers = ${renderInlineStringTable(headers)}`);
    } else {
      lines.push(`command = ${quoteTomlString(command)}`);
      const args = asStringArray(server.args);
      if (args) lines.push(`args = ${renderStringArray(args)}`);
    }

    const env = asStringRecord(server.env);
    if (env && !url) {
      lines.push('');
      lines.push(`[${table}.env]`);
      for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${quoteTomlKey(key)} = ${quoteTomlString(value)}`);
      }
    }
    lines.push('');
    count++;
  }

  if (count === 0) return { text: '', count: 0 };
  return {
    text: [BEGIN_MARKER, ...lines, END_MARKER].join('\n').trimEnd(),
    count,
  };
}

export function syncCodexMcpConfig(
  options: SyncCodexMcpConfigOptions,
): SyncCodexMcpConfigResult {
  fs.mkdirSync(options.codexHome, { recursive: true, mode: 0o700 });
  const configPath = path.join(options.codexHome, 'config.toml');
  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf-8')
    : '';
  const base = stripManagedBlock(existing);
  const workspaceSettings = readWorkspaceSettings(options.workspaceRoot);
  const managed = renderManagedBlock({
    ...asMcpServers(options.userMcpServers),
    ...asMcpServers(workspaceSettings.mcpServers),
  });

  const next = managed.text
    ? [base, managed.text].filter(Boolean).join('\n\n') + '\n'
    : base
      ? `${base}\n`
      : '';

  if (next) {
    fs.writeFileSync(configPath, next, { mode: 0o600 });
  } else {
    fs.rmSync(configPath, { force: true });
  }

  return { syncedServers: managed.count, configPath };
}
