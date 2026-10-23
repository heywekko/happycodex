import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
const runnerPath = path.resolve('container/agent-runner/src/index.ts');

const fakeCodexScript = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const callsPath = process.env.TEST_CODEX_CALLS;
  fs.appendFileSync(callsPath, JSON.stringify({ args, prompt }) + '\n');
  const count = fs.readFileSync(callsPath, 'utf8').trim().split('\n').length;
  const inputDir = path.join(process.env.HAPPYCLAW_WORKSPACE_IPC, 'input');
  if (count === 1) {
    // Queue the next input after startup drain, before the first answer exists.
    fs.writeFileSync(path.join(inputDir, 'next-message.json'), JSON.stringify({
      type: 'message', text: 'second input waiting for delivery',
      sourceJid: 'wechat:runner-test'
    }));
  } else {
    // Let the long-lived control case exit naturally after its second query.
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  }
  const answer = 'answer-' + count;
  const outputIndex = args.indexOf('--output-last-message');
  fs.writeFileSync(args[outputIndex + 1], answer);
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-im-recovery' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text: answer }
  }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`;

async function runRunner(stopAfterReply: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-im-runner-'));
  const workspace = path.join(root, 'workspace');
  const ipc = path.join(root, 'ipc');
  const codexHome = path.join(root, 'codex-home');
  const fakeCodexPath = path.join(root, 'fake-codex.cjs');
  const callsPath = path.join(root, 'calls.jsonl');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(ipc, 'input'), { recursive: true });
  fs.writeFileSync(fakeCodexPath, fakeCodexScript, { mode: 0o755 });
  const child = spawn(process.execPath, ['--import', tsxLoader, runnerPath], {
    cwd: workspace,
    // Do not inherit host credentials, auth locks, or the production CODEX_HOME.
    env: {
      PATH: process.env.PATH,
      CODEX_BIN: fakeCodexPath,
      CODEX_HOME: codexHome,
      CODEX_MODEL: 'gpt-6.1-sol',
      HAPPYCLAW_WORKSPACE_GROUP: workspace,
      HAPPYCLAW_WORKSPACE_IPC: ipc,
      TEST_CODEX_CALLS: callsPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const exit = new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Runner did not exit: ${stderr}`));
      }, 8_000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    child.stdin.end(
      JSON.stringify({
        prompt: 'first input',
        turnId: 'first-input',
        groupFolder: 'runner-test',
        chatJid: 'wechat:runner-test',
        isHome: false,
        stopAfterReply,
      }),
    );
    const code = await exit;
    const calls = fs.existsSync(callsPath)
      ? fs
          .readFileSync(callsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { args: string[]; prompt: string })
      : [];
    const outputs = [
      ...stdout.matchAll(
        /---HAPPYCLAW_OUTPUT_START---\s*([^\n]+)\s*---HAPPYCLAW_OUTPUT_END---/g,
      ),
    ].map(
      (match) =>
        JSON.parse(match[1]) as {
          status: string;
          result: string | null;
          newSessionId?: string;
        },
    );
    const nextPath = path.join(ipc, 'input', 'next-message.json');
    return {
      code,
      calls,
      outputs,
      stderr,
      nextInput: fs.existsSync(nextPath)
        ? JSON.parse(fs.readFileSync(nextPath, 'utf8'))
        : null,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('IM runner delivery boundary', () => {
  test('stops after one query and preserves queued input for host recovery', async () => {
    const result = await runRunner(true);
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].prompt).toContain('first input');
    expect(result.calls[0].prompt).not.toContain(
      'second input waiting for delivery',
    );
    expect(result.nextInput).toMatchObject({
      type: 'message',
      text: 'second input waiting for delivery',
    });
    expect(result.outputs.filter((output) => output.result)).toEqual([
      expect.objectContaining({
        status: 'success',
        result: 'answer-1',
        newSessionId: 'thread-im-recovery',
      }),
    ]);
  }, 10_000);

  test('the normal runner consumes the same queued input and resumes another query', async () => {
    const result = await runRunner(false);
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1].prompt).toContain(
      'second input waiting for delivery',
    );
    expect(result.calls[1].args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(result.calls[1].args).toContain('thread-im-recovery');
    expect(result.nextInput).toBeNull();
  }, 10_000);
});
