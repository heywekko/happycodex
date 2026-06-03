import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCodexExecArgs,
  isCodexContextOverflowError,
  isCodexResumeSessionMissingError,
  parseCodexJsonlLine,
  resolveCodexExecutable,
  runCodexExec,
} from '../container/agent-runner/src/codex-cli.js';
import { buildCodexPromptForSession } from '../container/agent-runner/src/codex-prompt.js';
import { syncCodexRuntimeGuidance } from '../container/agent-runner/src/codex-runtime-guidance.js';
import {
  buildCodexRuntimeContextAudit,
  shouldEmitCodexContextAudit,
} from '../container/agent-runner/src/codex-runtime-adapter.js';
import { buildRuntimeSkillsPrompt } from '../container/agent-runner/src/runtime-skills.js';
import type { RuntimeContextAudit } from '../container/agent-runner/src/stream-event.types.js';

const fakeCodexPath = path.join(os.tmpdir(), 'happycodex-fake-codex-exec.js');
let tmpRoot = '';

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
  const isResume = args[0] === 'exec' && args[1] === 'resume';
  const sessionId = isResume ? args[args.length - 2] : null;
  if (outputPath) {
    fs.writeFileSync(outputPath, (isResume ? 'resumed' : 'started') + ': ' + prompt.trim() + '\\n');
  }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: isResume ? sessionId : 'thread-new' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'ignored because output file wins' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`;

describe('Codex CLI adapter', () => {
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousCodexApiKey = process.env.CODEX_API_KEY;
  const previousCodexAccessToken = process.env.CODEX_ACCESS_TOKEN;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-codex-cli-'));
    fs.writeFileSync(fakeCodexPath, fakeCodexScript, { mode: 0o755 });
    process.env.OPENAI_API_KEY = 'host-key-must-not-leak';
    process.env.CODEX_API_KEY = 'host-codex-api-key-must-not-leak';
    process.env.CODEX_ACCESS_TOKEN = 'host-token-must-not-leak';
    process.env.CLAUDE_CONFIG_DIR = 'host-claude-dir-must-not-leak';
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(fakeCodexPath, { force: true });
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

  test('builds new-run args with stdin prompt and output-last-message', () => {
    const args = buildCodexExecArgs(
      {
        prompt: 'hello',
        cwd: '/workspace',
        codexHome: '/runtime/.codex',
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        sandbox: 'read-only',
        writableRoots: ['/workspace/user-skills', '/workspace/user-skills'],
      },
      '/tmp/last-message.txt',
    );

    expect(args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--output-last-message',
      '/tmp/last-message.txt',
      '--ask-for-approval',
      'never',
      '--model',
      'gpt-5.5',
      '--config',
      'model_reasoning_effort="xhigh"',
      '--config',
      'sandbox_workspace_write.writable_roots=["/workspace/user-skills"]',
      '--sandbox',
      'read-only',
      '--cd',
      '/workspace',
      '-',
    ]);
  });

  test('allows overriding the non-interactive approval policy', () => {
    const args = buildCodexExecArgs(
      {
        prompt: 'hello',
        cwd: '/workspace',
        codexHome: '/runtime/.codex',
        approvalPolicy: 'on-request',
      },
      '/tmp/last-message.txt',
    );

    const approvalIndex = args.indexOf('--ask-for-approval');
    expect(approvalIndex).toBeGreaterThan(-1);
    expect(args[approvalIndex + 1]).toBe('on-request');
  });

  test('parses JSONL object lines', () => {
    expect(
      parseCodexJsonlLine('{"type":"thread.started","thread_id":"t1"}'),
    ).toEqual({
      type: 'thread.started',
      thread_id: 't1',
    });
    expect(parseCodexJsonlLine('')).toBeNull();
  });

  test('resolves user-level Codex install when service PATH omits it', () => {
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousCodexBin = process.env.CODEX_BIN;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-home-'));
    const userBin = path.join(tmpHome, '.local', 'bin');
    const userCodex = path.join(userBin, 'codex');

    try {
      fs.mkdirSync(userBin, { recursive: true });
      fs.writeFileSync(userCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.HOME = tmpHome;
      process.env.PATH = '/usr/bin:/bin';
      delete process.env.CODEX_BIN;

      expect(resolveCodexExecutable()).toBe(userCodex);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousCodexBin;
    }
  });

  test('runs a new Codex exec and captures thread id plus final answer', async () => {
    const result = await runCodexExec({
      codexBin: fakeCodexPath,
      prompt: 'hello codex',
      cwd: tmpRoot,
      codexHome: path.join(tmpRoot, '.codex'),
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });

    expect(result.exitCode).toBe(0);
    expect(result.threadId).toBe('thread-new');
    expect(result.finalAnswer).toBe('started: hello codex');
    expect(result.events.map((event) => event.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'turn.completed',
    ]);
  });

  test('runs Codex resume with the existing session id', async () => {
    const result = await runCodexExec({
      codexBin: fakeCodexPath,
      prompt: 'continue',
      cwd: tmpRoot,
      codexHome: path.join(tmpRoot, '.codex'),
      sessionId: 'thread-existing',
    });

    expect(result.exitCode).toBe(0);
    expect(result.threadId).toBe('thread-existing');
    expect(result.finalAnswer).toBe('resumed: continue');
  });

  test('does not turn unavailable Codex context usage into a warning', () => {
    const baseAudit: RuntimeContextAudit = {
      executionMode: 'host',
      cwd: '/workspace/group',
      instructions: { status: 'unavailable' },
      rules: { status: 'unavailable', fileCount: 0 },
      skills: { sources: [] },
      runtimePrompt: { totalBytes: 0, files: [] },
      warnings: [],
    };

    const audit = buildCodexRuntimeContextAudit(baseAudit, {
      totalBytes: 123,
      files: [{ name: 'guidelines', bytes: 123 }],
    });

    expect(audit.runtimePrompt.totalBytes).toBe(123);
    expect(audit.warnings).toEqual([]);
    expect(shouldEmitCodexContextAudit(audit)).toBe(false);
    expect(
      shouldEmitCodexContextAudit({
        ...audit,
        warnings: ['real runtime warning'],
      }),
    ).toBe(true);
  });

  test('keeps final answers on the direct output path', async () => {
    const result = await runCodexExec({
      codexBin: fakeCodexPath,
      prompt: 'direct answer',
      cwd: tmpRoot,
      codexHome: path.join(tmpRoot, '.codex'),
    });

    expect(result.finalAnswer).toBe('started: direct answer');
  });

  test('wraps only the current user message for Codex sessions', () => {
    const freshPrompt = buildCodexPromptForSession({
      prompt: 'hello',
    });

    expect(freshPrompt).toBe('<user-message>\nhello\n</user-message>');
    expect(freshPrompt).not.toContain('<runtime-skills>');

    const resumedPrompt = buildCodexPromptForSession({
      prompt: 'continue',
    });

    expect(resumedPrompt).toBe('<user-message>\ncontinue\n</user-message>');
    expect(resumedPrompt).not.toContain('<runtime-skills>');
  });

  test('syncs runtime guidance into managed Codex AGENTS.md block', () => {
    const codexHome = path.join(tmpRoot, '.codex-guidance');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'AGENTS.md'),
      '# User Guidance\n\nKeep this line.\n',
    );

    syncCodexRuntimeGuidance({
      codexHome,
      runtimeGuidance: '<behavior>first</behavior>',
    });
    syncCodexRuntimeGuidance({
      codexHome,
      runtimeGuidance: '<behavior>second</behavior>',
    });

    const agents = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('# User Guidance');
    expect(agents).toContain('Keep this line.');
    expect(agents).toContain('<behavior>second</behavior>');
    expect(agents).not.toContain('<behavior>first</behavior>');
  });

  test('builds a compact runtime skill catalog instead of injecting skill bodies', () => {
    const skillRoot = path.join(tmpRoot, 'skills');
    const skillDir = path.join(skillRoot, 'example-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: example-skill',
        'description: Use when the user asks for an example workflow.',
        '---',
        '',
        'SECRET FULL BODY SHOULD NOT BE IN INITIAL RUNTIME GUIDANCE',
      ].join('\n'),
    );

    const result = buildRuntimeSkillsPrompt({
      executionMode: 'host',
      cwd: tmpRoot,
      instructions: { status: 'unavailable' },
      rules: { status: 'unavailable', fileCount: 0 },
      skills: {
        sources: [
          {
            name: 'user',
            sourcePath: skillRoot,
            runtimePath: skillRoot,
            count: 1,
          },
        ],
      },
      runtimePrompt: { totalBytes: 0, files: [] },
      warnings: [],
    });

    expect(result.includedSkills).toBe(1);
    expect(result.roots).toEqual([skillRoot]);
    expect(result.prompt).toContain('example-skill');
    expect(result.prompt).toContain(
      'Use when the user asks for an example workflow.',
    );
    expect(result.prompt).toContain(path.join(skillDir, 'SKILL.md'));
    expect(result.prompt).not.toContain('SECRET FULL BODY');
  });

  test('detects Codex resume context overflow errors', () => {
    expect(
      isCodexContextOverflowError(
        'ERROR codex_core::compact_remote: remote compaction failed\n' +
          'Your input exceeds the context window of this model.\n' +
          'ERROR codex_core::session::turn: Failed to run pre-sampling compact',
      ),
    ).toBe(true);
    expect(
      isCodexContextOverflowError(
        '{"code":"context_length_exceeded","message":"too long"}',
      ),
    ).toBe(true);
    expect(isCodexContextOverflowError('401 Invalid authentication')).toBe(
      false,
    );
  });

  test('detects Codex resume sessions whose rollout files are missing', () => {
    expect(
      isCodexResumeSessionMissingError(
        'thread/resume: thread/resume failed: no rollout found for thread id 019e8af1-e7d8-7a91-9253-ec687ade0212 (code -32600)',
      ),
    ).toBe(true);
    expect(
      isCodexResumeSessionMissingError('no rollout found for thread id t1'),
    ).toBe(false);
    expect(isCodexResumeSessionMissingError('401 Invalid authentication')).toBe(
      false,
    );
  });
});
