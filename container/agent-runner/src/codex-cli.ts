import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface CodexExecOptions {
  prompt: string;
  cwd: string;
  codexHome: string;
  sessionId?: string;
  codexBin?: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  images?: string[];
  writableRoots?: string[];
  outputLastMessagePath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: CodexJsonEvent) => void;
}

export interface CodexExecResult {
  exitCode: number | null;
  threadId?: string;
  finalAnswer: string;
  events: CodexJsonEvent[];
  stderr: string;
  outputLastMessagePath: string;
}

export type CodexJsonEvent = Record<string, unknown>;

interface SpawnResult {
  exitCode: number | null;
  stderr: string;
}

function isExecutable(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
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

export function resolveCodexExecutable(configured?: string): string {
  const explicit = configured?.trim();
  if (explicit) {
    if (/[\\/]/.test(explicit)) return explicit;
    return findExecutableOnSearchPath(explicit) ?? explicit;
  }
  return findExecutableOnSearchPath('codex') ?? 'codex';
}

function getCodexExecutable(options: CodexExecOptions): string {
  return resolveCodexExecutable(options.codexBin || process.env.CODEX_BIN);
}

function buildCodexEnv(options: CodexExecOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    CODEX_HOME: options.codexHome,
  };

  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;

  return env;
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function toTomlStringArray(values: string[]): string {
  return `[${values.map(toTomlString).join(', ')}]`;
}

function normalizeWritableRoots(roots: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots ?? []) {
    const normalized = root.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function buildCodexExecArgs(
  options: CodexExecOptions,
  outputLastMessagePath: string,
): string[] {
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--output-last-message',
    outputLastMessagePath,
    '--ask-for-approval',
    options.approvalPolicy ?? 'never',
  ];

  if (options.model) {
    common.push('--model', options.model);
  }
  if (options.reasoningEffort) {
    common.push(
      '--config',
      `model_reasoning_effort=${toTomlString(options.reasoningEffort)}`,
    );
  }
  const writableRoots = normalizeWritableRoots(options.writableRoots);
  if (writableRoots.length > 0) {
    common.push(
      '--config',
      `sandbox_workspace_write.writable_roots=${toTomlStringArray(writableRoots)}`,
    );
  }
  for (const image of options.images ?? []) {
    common.push('--image', image);
  }

  if (options.sessionId) {
    return ['exec', 'resume', ...common, options.sessionId, '-'];
  }

  return [
    'exec',
    ...common,
    '--sandbox',
    options.sandbox ?? 'workspace-write',
    '--cd',
    options.cwd,
    '-',
  ];
}

function extractThreadId(event: CodexJsonEvent): string | undefined {
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    return event.thread_id;
  }
  if (event.type === 'thread.started' && typeof event.threadId === 'string') {
    return event.threadId;
  }
  return undefined;
}

export function parseCodexJsonlLine(line: string): CodexJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex JSONL line is not an object');
  }
  return parsed as CodexJsonEvent;
}

export function isCodexContextOverflowError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes('context_length_exceeded') ||
    normalized.includes('exceeds the context window') ||
    normalized.includes('maximum context length') ||
    (normalized.includes('compact_remote') &&
      normalized.includes('failed to run pre-sampling compact'))
  );
}

export function isCodexResumeSessionMissingError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes('thread/resume') &&
    normalized.includes('no rollout found for thread id')
  );
}

async function createOutputLastMessagePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'happycodex-codex-'));
  return path.join(dir, 'last-message.txt');
}

async function readFinalAnswer(outputPath: string): Promise<string> {
  try {
    return (await fs.readFile(outputPath, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function spawnCodex(
  options: CodexExecOptions,
  args: string[],
  onJsonEvent: (event: CodexJsonEvent) => void,
): Promise<SpawnResult> {
  await fs.mkdir(options.codexHome, { recursive: true, mode: 0o700 });

  return new Promise((resolve, reject) => {
    const child = spawn(getCodexExecutable(options), args, {
      cwd: options.cwd,
      env: buildCodexEnv(options),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill('SIGTERM');
      reject(err);
    };

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            fail(new Error('Codex exec timed out'));
          }, options.timeoutMs)
        : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = parseCodexJsonlLine(line);
          if (event) onJsonEvent(event);
        } catch (err) {
          fail(
            err instanceof Error
              ? err
              : new Error('Failed to parse Codex JSONL'),
          );
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        const event = parseCodexJsonlLine(stdoutBuffer);
        if (event) onJsonEvent(event);
        resolve({ exitCode, stderr });
      } catch (err) {
        reject(
          err instanceof Error ? err : new Error('Failed to parse Codex JSONL'),
        );
      }
    });

    child.stdin.end(options.prompt);
  });
}

export async function runCodexExec(
  options: CodexExecOptions,
): Promise<CodexExecResult> {
  const outputLastMessagePath =
    options.outputLastMessagePath ?? (await createOutputLastMessagePath());
  const args = buildCodexExecArgs(options, outputLastMessagePath);
  const events: CodexJsonEvent[] = [];
  let threadId: string | undefined;

  const spawnResult = await spawnCodex(options, args, (event) => {
    events.push(event);
    threadId = extractThreadId(event) ?? threadId;
    options.onEvent?.(event);
  });

  return {
    exitCode: spawnResult.exitCode,
    threadId,
    finalAnswer: await readFinalAnswer(outputLastMessagePath),
    events,
    stderr: spawnResult.stderr,
    outputLastMessagePath,
  };
}
