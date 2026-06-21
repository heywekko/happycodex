import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from './config.js';

const CODEX_COMMAND_TIMEOUT_MS = 15_000;
const DEVICE_AUTH_PROMPT_TIMEOUT_MS = 15_000;
const DEVICE_AUTH_DEFAULT_EXPIRES_MS = 15 * 60 * 1000;
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_REASONING_EFFORT = 'xhigh';
export const CODEX_MODEL_PRESETS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
] as const;
export const CODEX_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const;
export const CODEX_RUNTIME_SETTINGS_FILE = path.join(
  DATA_DIR,
  'config',
  'codex-runtime-settings.json',
);
const CODEX_RUNTIME_CONFIG_BEGIN = '# BEGIN HAPPYCODEX RUNTIME CONFIG';
const CODEX_RUNTIME_CONFIG_END = '# END HAPPYCODEX RUNTIME CONFIG';

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export interface CodexRuntimeSettings {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  updatedAt: string | null;
}

export interface CodexRuntimeStatus {
  configured: boolean;
  statusText: string;
  authFileExists: boolean;
  runtimeHomeRelative: string;
  updatedAt: string | null;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  modelPresets: readonly string[];
  reasoningEfforts: readonly CodexReasoningEffort[];
  error?: string;
}

export type CodexDeviceAuthStatus =
  | 'pending'
  | 'complete'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface CodexDeviceAuthLogin {
  id: string;
  status: CodexDeviceAuthStatus;
  verificationUri: string;
  userCode: string;
  expiresAt: string;
  runtimeHomeRelative: string;
  message?: string;
}

export type CodexBrowserAuthStatus = CodexDeviceAuthStatus;

export interface CodexBrowserAuthLogin {
  id: string;
  status: CodexBrowserAuthStatus;
  runtimeHomeRelative: string;
  message?: string;
}

interface CodexCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CodexBrowserAuthLoginRecord extends CodexBrowserAuthLogin {
  child: ChildProcess;
  groupFolder: string;
  output: string;
  exitCode: number | null;
}

interface CodexDeviceAuthLoginRecord extends CodexDeviceAuthLogin {
  child: ChildProcess;
  groupFolder: string;
  output: string;
  exitCode: number | null;
}

const browserAuthLogins = new Map<string, CodexBrowserAuthLoginRecord>();
const deviceAuthLogins = new Map<string, CodexDeviceAuthLoginRecord>();

function normalizeGroupFolder(groupFolder: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(groupFolder)) {
    throw new Error('Invalid group folder');
  }
  return groupFolder;
}

function normalizeModel(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model) return DEFAULT_CODEX_MODEL;
  if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
    throw new Error('Invalid Codex model');
  }
  return model;
}

function normalizeReasoningEffort(value: unknown): CodexReasoningEffort {
  const effort =
    typeof value === 'string' ? value.trim() : DEFAULT_CODEX_REASONING_EFFORT;
  if (CODEX_REASONING_EFFORTS.includes(effort as CodexReasoningEffort)) {
    return effort as CodexReasoningEffort;
  }
  throw new Error('Invalid Codex reasoning effort');
}

function defaultCodexRuntimeSettings(): CodexRuntimeSettings {
  return {
    model: normalizeModel(process.env.CODEX_MODEL),
    reasoningEffort: normalizeReasoningEffort(
      process.env.CODEX_MODEL_REASONING_EFFORT ||
        process.env.CODEX_REASONING_EFFORT ||
        DEFAULT_CODEX_REASONING_EFFORT,
    ),
    updatedAt: null,
  };
}

export function getCodexRuntimeSettings(): CodexRuntimeSettings {
  const defaults = defaultCodexRuntimeSettings();
  try {
    const raw = JSON.parse(
      fs.readFileSync(CODEX_RUNTIME_SETTINGS_FILE, 'utf8'),
    ) as Record<string, unknown>;
    return {
      model: normalizeModel(raw.model ?? defaults.model),
      reasoningEffort: normalizeReasoningEffort(
        raw.reasoningEffort ?? defaults.reasoningEffort,
      ),
      updatedAt:
        typeof raw.updatedAt === 'string' && raw.updatedAt
          ? raw.updatedAt
          : null,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid Codex')) {
      throw err;
    }
    return defaults;
  }
}

export function saveCodexRuntimeSettings(input: {
  model?: unknown;
  reasoningEffort?: unknown;
}): CodexRuntimeSettings {
  const current = getCodexRuntimeSettings();
  const settings: CodexRuntimeSettings = {
    model: normalizeModel(input.model ?? current.model),
    reasoningEffort: normalizeReasoningEffort(
      input.reasoningEffort ?? current.reasoningEffort,
    ),
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(CODEX_RUNTIME_SETTINGS_FILE), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(
    CODEX_RUNTIME_SETTINGS_FILE,
    JSON.stringify(settings) + '\n',
    {
      mode: 0o600,
    },
  );
  try {
    fs.chmodSync(CODEX_RUNTIME_SETTINGS_FILE, 0o600);
  } catch {
    /* chmod is best-effort on filesystems that do not preserve modes. */
  }

  return settings;
}

export function getCodexRuntimeHome(groupFolder = 'main'): string {
  const folder = normalizeGroupFolder(groupFolder);
  return path.join(DATA_DIR, 'sessions', folder, '.codex');
}

export interface CodexRuntimeCredentialMaterialization {
  authCopied: boolean;
  configCopied: boolean;
}

function copyRuntimeFileIfMissing(
  sourcePath: string,
  targetPath: string,
): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, targetPath);
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    /* chmod is best-effort on filesystems that do not preserve modes. */
  }
  return true;
}

function copyRuntimeFile(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(sourcePath)) return false;
  const source = fs.readFileSync(sourcePath);
  if (fs.existsSync(targetPath)) {
    const target = fs.readFileSync(targetPath);
    if (source.equals(target)) return false;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, targetPath);
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    /* chmod is best-effort on filesystems that do not preserve modes. */
  }
  return true;
}

export function materializeCodexRuntimeCredentials(
  groupFolder = 'main',
): CodexRuntimeCredentialMaterialization {
  const normalizedGroupFolder = normalizeGroupFolder(groupFolder);
  const targetHome = ensureCodexRuntimeHome(normalizedGroupFolder);
  if (normalizedGroupFolder === 'main') {
    ensureCodexRuntimeConfig(targetHome);
    return { authCopied: false, configCopied: false };
  }

  const sourceHome = getCodexRuntimeHome('main');

  const result = {
    authCopied: copyRuntimeFile(
      path.join(sourceHome, 'auth.json'),
      path.join(targetHome, 'auth.json'),
    ),
    configCopied: copyRuntimeFileIfMissing(
      path.join(sourceHome, 'config.toml'),
      path.join(targetHome, 'config.toml'),
    ),
  };
  ensureCodexRuntimeConfig(targetHome);
  return result;
}

export function materializeCodexRuntimeCredentialsToHome(
  targetHome: string,
): CodexRuntimeCredentialMaterialization {
  fs.mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  const sourceHome = getCodexRuntimeHome('main');

  if (path.resolve(targetHome) === path.resolve(sourceHome)) {
    ensureCodexRuntimeConfig(targetHome);
    return { authCopied: false, configCopied: false };
  }

  const result = {
    authCopied: copyRuntimeFile(
      path.join(sourceHome, 'auth.json'),
      path.join(targetHome, 'auth.json'),
    ),
    configCopied: copyRuntimeFileIfMissing(
      path.join(sourceHome, 'config.toml'),
      path.join(targetHome, 'config.toml'),
    ),
  };
  ensureCodexRuntimeConfig(targetHome);
  return result;
}

function getCodexRuntimeHomeRelative(groupFolder = 'main'): string {
  const folder = normalizeGroupFolder(groupFolder);
  return path.join('data', 'sessions', folder, '.codex');
}

function ensureCodexRuntimeHome(groupFolder = 'main'): string {
  const runtimeHome = getCodexRuntimeHome(groupFolder);
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  return runtimeHome;
}

function stripManagedRuntimeConfig(config: string): string {
  const pattern = new RegExp(
    `\\n?${CODEX_RUNTIME_CONFIG_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CODEX_RUNTIME_CONFIG_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'g',
  );
  return config.replace(pattern, '\n').trimEnd();
}

function stripAuthCredentialStore(config: string): string {
  return config
    .split(/\r?\n/)
    .filter((line) => !/^\s*cli_auth_credentials_store\s*=/.test(line.trim()))
    .join('\n')
    .trimEnd();
}

function ensureCodexRuntimeConfig(runtimeHome: string): void {
  const configPath = path.join(runtimeHome, 'config.toml');
  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf-8')
    : '';
  const base = stripAuthCredentialStore(stripManagedRuntimeConfig(existing));
  const managed = [
    CODEX_RUNTIME_CONFIG_BEGIN,
    'cli_auth_credentials_store = "file"',
    CODEX_RUNTIME_CONFIG_END,
  ].join('\n');
  const next = [base, managed].filter(Boolean).join('\n\n') + '\n';

  fs.writeFileSync(configPath, next, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* chmod is best-effort on filesystems that do not preserve modes. */
  }
}

export function prepareCodexRuntimeHome(groupFolder = 'main'): string {
  const runtimeHome = ensureCodexRuntimeHome(groupFolder);
  ensureCodexRuntimeConfig(runtimeHome);
  return runtimeHome;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getCodexSearchDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const addDir = (dir: string | undefined) => {
    const normalized = dir?.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    dirs.push(normalized);
  };

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    addDir(dir);
  }

  const home = process.env.HOME?.trim() || os.homedir();
  addDir(home ? path.join(home, '.local', 'bin') : undefined);
  addDir(
    home
      ? path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin')
      : undefined,
  );
  addDir('/opt/homebrew/bin');
  addDir('/usr/local/bin');
  addDir('/usr/bin');
  addDir('/bin');

  return dirs;
}

function findExecutableOnSearchPath(commandName: string): string | null {
  for (const dir of getCodexSearchDirs()) {
    const candidate = path.join(dir, commandName);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveCodexExecutable(
  configured = process.env.CODEX_BIN,
): string {
  const explicit = configured?.trim();
  if (explicit) {
    if (/[\\/]/.test(explicit)) return explicit;
    return findExecutableOnSearchPath(explicit) ?? explicit;
  }
  return findExecutableOnSearchPath('codex') ?? 'codex';
}

function getCodexExecutable(): string {
  return resolveCodexExecutable();
}

function buildCodexEnv(runtimeHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: runtimeHome };

  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;

  return env;
}

function sanitizeCodexOutput(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('WARNING: proceeding'))
    .join('\n');
}

function firstCodexOutputLine(result: CodexCommandResult): string {
  return (
    (
      sanitizeCodexOutput(result.stdout) ||
      sanitizeCodexOutput(result.stderr) ||
      ''
    ).split(/\r?\n/)[0] || ''
  );
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseDeviceAuthOutput(text: string): {
  verificationUri: string;
  userCode: string;
  expiresAt: string;
} | null {
  const cleaned = stripAnsi(text);
  const verificationUri = cleaned.match(
    /https:\/\/auth\.openai\.com\/codex\/device[^\s]*/i,
  )?.[0];
  const userCode = cleaned.match(
    /^[ \t]*([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})+)[ \t]*$/m,
  )?.[1];

  if (!verificationUri || !userCode) return null;

  const expiresInMinutes = Number(
    cleaned.match(/expires in\s+(\d+)\s+minutes?/i)?.[1] ?? '',
  );
  const expiresMs =
    Number.isFinite(expiresInMinutes) && expiresInMinutes > 0
      ? expiresInMinutes * 60 * 1000
      : DEVICE_AUTH_DEFAULT_EXPIRES_MS;

  return {
    verificationUri,
    userCode,
    expiresAt: new Date(Date.now() + expiresMs).toISOString(),
  };
}

function toPublicDeviceAuthLogin(
  record: CodexDeviceAuthLoginRecord,
): CodexDeviceAuthLogin {
  return {
    id: record.id,
    status: record.status,
    verificationUri: record.verificationUri,
    userCode: record.userCode,
    expiresAt: record.expiresAt,
    runtimeHomeRelative: record.runtimeHomeRelative,
    ...(record.message ? { message: record.message } : {}),
  };
}

function toPublicBrowserAuthLogin(
  record: CodexBrowserAuthLoginRecord,
): CodexBrowserAuthLogin {
  return {
    id: record.id,
    status: record.status,
    runtimeHomeRelative: record.runtimeHomeRelative,
    ...(record.message ? { message: record.message } : {}),
  };
}

function stopBrowserAuthProcess(record: CodexBrowserAuthLoginRecord): void {
  if (record.child.exitCode === null && !record.child.killed) {
    record.child.kill('SIGTERM');
  }
}

function stopDeviceAuthProcess(record: CodexDeviceAuthLoginRecord): void {
  if (record.child.exitCode === null && !record.child.killed) {
    record.child.kill('SIGTERM');
  }
}

function markBrowserAuthLogin(
  record: CodexBrowserAuthLoginRecord,
  status: CodexBrowserAuthStatus,
  message?: string,
): void {
  record.status = status;
  if (message) record.message = message;
  if (status !== 'pending') stopBrowserAuthProcess(record);
}

function markDeviceAuthLogin(
  record: CodexDeviceAuthLoginRecord,
  status: CodexDeviceAuthStatus,
  message?: string,
): void {
  record.status = status;
  if (message) record.message = message;
  if (status !== 'pending') stopDeviceAuthProcess(record);
}

function cancelPendingBrowserAuthLoginsForGroup(groupFolder: string): void {
  for (const record of browserAuthLogins.values()) {
    if (record.groupFolder !== groupFolder || record.status !== 'pending') {
      continue;
    }
    markBrowserAuthLogin(
      record,
      'cancelled',
      'Browser auth login was cancelled',
    );
  }
}

function cancelPendingDeviceAuthLoginsForGroup(groupFolder: string): void {
  for (const record of deviceAuthLogins.values()) {
    if (record.groupFolder !== groupFolder || record.status !== 'pending') {
      continue;
    }
    markDeviceAuthLogin(record, 'cancelled', 'Device auth login was cancelled');
  }
}

function runCodexCommand(
  args: string[],
  options: {
    groupFolder?: string;
    input?: string;
    timeoutMs?: number;
  } = {},
): Promise<CodexCommandResult> {
  const runtimeHome = prepareCodexRuntimeHome(options.groupFolder);

  return new Promise((resolve, reject) => {
    const child = spawn(getCodexExecutable(), args, {
      cwd: DATA_DIR,
      env: buildCodexEnv(runtimeHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Codex command timed out'));
    }, options.timeoutMs ?? CODEX_COMMAND_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function readAuthFileUpdatedAt(runtimeHome: string): string | null {
  const authPath = path.join(runtimeHome, 'auth.json');
  try {
    return fs.statSync(authPath).mtime.toISOString();
  } catch {
    return null;
  }
}

export async function getCodexRuntimeStatus(
  groupFolder = 'main',
): Promise<CodexRuntimeStatus> {
  const runtimeHome = ensureCodexRuntimeHome(groupFolder);
  const authPath = path.join(runtimeHome, 'auth.json');
  const authFileExists = fs.existsSync(authPath);
  const settings = getCodexRuntimeSettings();
  const settingsFields = {
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    modelPresets: CODEX_MODEL_PRESETS,
    reasoningEfforts: CODEX_REASONING_EFFORTS,
  };

  try {
    const result = await runCodexCommand(['login', 'status'], {
      groupFolder,
      timeoutMs: 10_000,
    });
    const statusText = firstCodexOutputLine(result) || 'Unknown status';
    return {
      configured: result.code === 0,
      statusText,
      authFileExists,
      runtimeHomeRelative: getCodexRuntimeHomeRelative(groupFolder),
      updatedAt: readAuthFileUpdatedAt(runtimeHome),
      ...settingsFields,
      ...(result.code === 0 ? {} : { error: statusText }),
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to read Codex status';
    return {
      configured: false,
      statusText: message,
      authFileExists,
      runtimeHomeRelative: getCodexRuntimeHomeRelative(groupFolder),
      updatedAt: readAuthFileUpdatedAt(runtimeHome),
      ...settingsFields,
      error: message,
    };
  }
}

export async function loginCodexRuntimeWithApiKey(
  apiKey: string,
  groupFolder = 'main',
): Promise<CodexRuntimeStatus> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('API key is required');
  }

  const result = await runCodexCommand(['login', '--with-api-key'], {
    groupFolder,
    input: `${trimmed}\n`,
    timeoutMs: 30_000,
  });

  if (result.code !== 0) {
    const message = firstCodexOutputLine(result) || 'Codex login failed';
    throw new Error(message);
  }

  return getCodexRuntimeStatus(groupFolder);
}

export function startCodexRuntimeBrowserAuthLogin(
  groupFolder = 'main',
): Promise<CodexBrowserAuthLogin> {
  const normalizedGroupFolder = normalizeGroupFolder(groupFolder);
  const runtimeHome = prepareCodexRuntimeHome(normalizedGroupFolder);

  cancelPendingBrowserAuthLoginsForGroup(normalizedGroupFolder);
  cancelPendingDeviceAuthLoginsForGroup(normalizedGroupFolder);

  return new Promise((resolve, reject) => {
    const child = spawn(getCodexExecutable(), ['login'], {
      cwd: DATA_DIR,
      env: buildCodexEnv(runtimeHome),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const record: CodexBrowserAuthLoginRecord = {
      id: randomBytes(16).toString('hex'),
      status: 'pending',
      runtimeHomeRelative: getCodexRuntimeHomeRelative(normalizedGroupFolder),
      child,
      groupFolder: normalizedGroupFolder,
      output: '',
      exitCode: null,
    };
    browserAuthLogins.set(record.id, record);

    let settled = false;
    const resolveStarted = () => {
      if (settled) return;
      settled = true;
      resolve(toPublicBrowserAuthLogin(record));
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      record.output += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      record.output += chunk;
    });
    child.once('spawn', resolveStarted);
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        browserAuthLogins.delete(record.id);
        reject(err);
        return;
      }
      markBrowserAuthLogin(record, 'failed', err.message);
    });
    child.on('close', (code) => {
      record.exitCode = code;
      if (!settled) {
        settled = true;
        if (code === 0) {
          markBrowserAuthLogin(
            record,
            'complete',
            'Codex browser auth finished',
          );
          resolve(toPublicBrowserAuthLogin(record));
        } else {
          browserAuthLogins.delete(record.id);
          reject(
            new Error(
              sanitizeCodexOutput(record.output) || 'Codex browser auth failed',
            ),
          );
        }
        return;
      }
      if (record.status === 'pending') {
        markBrowserAuthLogin(
          record,
          code === 0 ? 'complete' : 'failed',
          code === 0
            ? 'Codex browser auth finished'
            : 'Codex browser auth failed',
        );
      }
    });
  });
}

export function startCodexRuntimeDeviceAuthLogin(
  groupFolder = 'main',
): Promise<CodexDeviceAuthLogin> {
  const normalizedGroupFolder = normalizeGroupFolder(groupFolder);
  const runtimeHome = prepareCodexRuntimeHome(normalizedGroupFolder);

  cancelPendingBrowserAuthLoginsForGroup(normalizedGroupFolder);
  cancelPendingDeviceAuthLoginsForGroup(normalizedGroupFolder);

  return new Promise((resolve, reject) => {
    const child = spawn(getCodexExecutable(), ['login', '--device-auth'], {
      cwd: DATA_DIR,
      env: buildCodexEnv(runtimeHome),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    let record: CodexDeviceAuthLoginRecord | null = null;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Codex device auth prompt timed out'));
    }, DEVICE_AUTH_PROMPT_TIMEOUT_MS);

    const tryResolve = () => {
      if (settled) return;
      const parsed = parseDeviceAuthOutput(output);
      if (!parsed) return;

      settled = true;
      clearTimeout(timeout);

      record = {
        id: randomBytes(16).toString('hex'),
        status: 'pending',
        verificationUri: parsed.verificationUri,
        userCode: parsed.userCode,
        expiresAt: parsed.expiresAt,
        runtimeHomeRelative: getCodexRuntimeHomeRelative(normalizedGroupFolder),
        child,
        groupFolder: normalizedGroupFolder,
        output,
        exitCode: null,
      };
      deviceAuthLogins.set(record.id, record);
      resolve(toPublicDeviceAuthLogin(record));
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (record) record.output = output;
      tryResolve();
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
      if (record) record.output = output;
      tryResolve();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(sanitizeCodexOutput(output) || 'Codex device auth failed'),
        );
        return;
      }
      if (!record) return;
      record.exitCode = code;
      if (record.status === 'pending') {
        markDeviceAuthLogin(
          record,
          code === 0 ? 'complete' : 'failed',
          code === 0
            ? 'Codex device auth finished'
            : 'Codex device auth failed',
        );
      }
    });
  });
}

export async function getCodexRuntimeBrowserAuthLogin(
  loginId: string,
): Promise<CodexBrowserAuthLogin | null> {
  const record = browserAuthLogins.get(loginId);
  if (!record) return null;

  if (record.status === 'pending') {
    const runtimeStatus = await getCodexRuntimeStatus(record.groupFolder);
    if (runtimeStatus.configured) {
      markBrowserAuthLogin(record, 'complete', 'Codex runtime is logged in');
    } else if (record.exitCode !== null) {
      markBrowserAuthLogin(
        record,
        record.exitCode === 0 ? 'complete' : 'failed',
        record.exitCode === 0
          ? 'Codex browser auth finished'
          : 'Codex browser auth failed',
      );
    }
  }

  return toPublicBrowserAuthLogin(record);
}

export async function getCodexRuntimeDeviceAuthLogin(
  loginId: string,
): Promise<CodexDeviceAuthLogin | null> {
  const record = deviceAuthLogins.get(loginId);
  if (!record) return null;

  if (record.status === 'pending') {
    if (Date.parse(record.expiresAt) <= Date.now()) {
      markDeviceAuthLogin(record, 'expired', 'Device auth login expired');
    } else {
      const runtimeStatus = await getCodexRuntimeStatus(record.groupFolder);
      if (runtimeStatus.configured) {
        markDeviceAuthLogin(record, 'complete', 'Codex runtime is logged in');
      }
    }
  }

  return toPublicDeviceAuthLogin(record);
}

export async function cancelCodexRuntimeBrowserAuthLogin(
  loginId: string,
): Promise<CodexBrowserAuthLogin | null> {
  const record = browserAuthLogins.get(loginId);
  if (!record) return null;

  if (record.status === 'pending') {
    markBrowserAuthLogin(
      record,
      'cancelled',
      'Browser auth login was cancelled',
    );
  }

  return toPublicBrowserAuthLogin(record);
}

export async function cancelCodexRuntimeDeviceAuthLogin(
  loginId: string,
): Promise<CodexDeviceAuthLogin | null> {
  const record = deviceAuthLogins.get(loginId);
  if (!record) return null;

  if (record.status === 'pending') {
    markDeviceAuthLogin(record, 'cancelled', 'Device auth login was cancelled');
  }

  return toPublicDeviceAuthLogin(record);
}

export async function logoutCodexRuntime(
  groupFolder = 'main',
): Promise<CodexRuntimeStatus> {
  const result = await runCodexCommand(['logout'], {
    groupFolder,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    const message = firstCodexOutputLine(result) || 'Codex logout failed';
    throw new Error(message);
  }

  return getCodexRuntimeStatus(groupFolder);
}
