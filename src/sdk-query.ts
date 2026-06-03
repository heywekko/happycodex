/**
 * Lightweight Codex text-in -> text-out helper for inherited HappyClaw product
 * surfaces that need a one-shot model call, such as task parsing, recall
 * summaries, bug report drafting, and title generation.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  prepareCodexRuntimeHome,
  getCodexRuntimeSettings,
  resolveCodexExecutable,
} from './codex-runtime.js';
import { logger } from './logger.js';

interface SpawnResult {
  exitCode: number | null;
  stderr: string;
}

function buildCodexEnv(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
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

async function createOutputPath(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'happycodex-sdk-query-'));
  return { dir, file: path.join(dir, 'last-message.txt') };
}

async function readFinalAnswer(file: string): Promise<string> {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function spawnCodexQuery(options: {
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  timeout: number;
  outputPath: string;
  groupFolder?: string;
}): Promise<SpawnResult> {
  const codexHome = prepareCodexRuntimeHome(options.groupFolder ?? 'main');

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ask-for-approval',
    'never',
    '--sandbox',
    'read-only',
    '--cd',
    process.cwd(),
    '--output-last-message',
    options.outputPath,
    ...(options.model ? ['--model', options.model] : []),
    ...(options.reasoningEffort
      ? [
          '--config',
          `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`,
        ]
      : []),
    '-',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(resolveCodexExecutable(), args, {
      cwd: process.cwd(),
      env: buildCodexEnv(codexHome),
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Codex query timed out'));
    }, options.timeout);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stderr });
    });

    child.stdin.end(options.prompt);
  });
}

/**
 * Send a prompt to the isolated service-managed Codex runtime and return the
 * final assistant text, or null when Codex is unavailable/not configured.
 */
export async function sdkQuery(
  prompt: string,
  opts?: {
    model?: string;
    reasoningEffort?: string;
    timeout?: number;
    groupFolder?: string;
  },
): Promise<string | null> {
  const timeout = opts?.timeout ?? 60_000;
  const output = await createOutputPath();
  const settings = getCodexRuntimeSettings();

  try {
    const result = await spawnCodexQuery({
      prompt,
      model: opts?.model ?? settings.model,
      reasoningEffort: opts?.reasoningEffort ?? settings.reasoningEffort,
      timeout,
      outputPath: output.file,
      groupFolder: opts?.groupFolder,
    });
    const finalAnswer = await readFinalAnswer(output.file);

    if (result.exitCode !== 0) {
      logger.warn(
        {
          exitCode: result.exitCode,
          stderr: result.stderr.trim().slice(0, 300),
        },
        'sdkQuery Codex exec failed',
      );
      return finalAnswer || null;
    }

    return finalAnswer || null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      'sdkQuery Codex exec failed',
    );
    return null;
  } finally {
    await fs.rm(output.dir, { recursive: true, force: true }).catch(() => {});
  }
}
