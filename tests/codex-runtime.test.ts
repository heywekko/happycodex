import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cancelCodexRuntimeBrowserAuthLogin,
  cancelCodexRuntimeDeviceAuthLogin,
  CODEX_MODEL_PRESETS,
  CODEX_RUNTIME_SETTINGS_FILE,
  getCodexRuntimeBrowserAuthLogin,
  getCodexRuntimeHome,
  getCodexRuntimeDeviceAuthLogin,
  getCodexRuntimeSettings,
  getCodexRuntimeStatus,
  loginCodexRuntimeWithApiKey,
  logoutCodexRuntime,
  materializeCodexRuntimeCredentials,
  materializeCodexRuntimeCredentialsToHome,
  resolveCodexExecutable,
  saveCodexRuntimeSettings,
  startCodexRuntimeBrowserAuthLogin,
  startCodexRuntimeDeviceAuthLogin,
} from '../src/codex-runtime.js';

const fakeCodexPath = path.join(os.tmpdir(), 'happycodex-fake-codex.js');
const groupFolder = 'codex-runtime-test';
const runtimeHome = getCodexRuntimeHome(groupFolder);
const groupSessionRoot = path.dirname(runtimeHome);
const mainRuntimeHome = getCodexRuntimeHome('main');

const fakeCodexScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const home = process.env.CODEX_HOME;
if (!home) {
  console.error('CODEX_HOME missing');
  process.exit(2);
}
if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN) {
  console.error('host Codex auth env leaked');
  process.exit(3);
}

const authPath = path.join(home, 'auth.json');
const args = process.argv.slice(2);

if (args[0] === 'login' && args[1] === 'status') {
  if (fs.existsSync(authPath)) {
    console.log('Logged in with API key');
    process.exit(0);
  }
  console.error('Not logged in');
  process.exit(1);
}

if (args[0] === 'login' && args[1] === '--with-api-key') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    if (!input.trim()) {
      console.error('missing key');
      process.exit(4);
    }
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ method: 'api-key', input: input.trim() }) + '\\n');
    console.log('Logged in');
    process.exit(0);
  });
  return;
}

if (args[0] === 'login' && args[1] === '--device-auth') {
  console.log('Welcome to Codex [v0.136.0]');
  console.log("Follow these steps to sign in with ChatGPT using device code ABCD-EFGH:");
  console.log('');
  console.log('1. Open this link in your browser and sign in to your account');
  console.log('   https://auth.openai.com/codex/device');
  console.log('');
  console.log('2. Enter this one-time code (expires in 15 minutes)');
  console.log('   ABCD-EFGH');
  console.log('');
  console.log('Device codes are a common phishing target. Never share this code.');
  setInterval(() => {}, 1000);
  return;
}

if (args[0] === 'login' && args.length === 1) {
  console.log('Opening browser for ChatGPT login');
  setInterval(() => {}, 1000);
  return;
}

if (args[0] === 'logout') {
  fs.rmSync(authPath, { force: true });
  console.log('Logged out');
  process.exit(0);
}

console.error('unknown command: ' + args.join(' '));
process.exit(9);
`;

describe('Codex runtime isolation', () => {
  const previousCodexBin = process.env.CODEX_BIN;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousCodexApiKey = process.env.CODEX_API_KEY;
  const previousCodexAccessToken = process.env.CODEX_ACCESS_TOKEN;
  let previousSettingsFile: string | null = null;
  let previousMainRuntimeFiles: Map<string, string> = new Map();

  beforeEach(() => {
    fs.writeFileSync(fakeCodexPath, fakeCodexScript, { mode: 0o755 });
    fs.rmSync(groupSessionRoot, { recursive: true, force: true });
    previousMainRuntimeFiles = new Map();
    for (const fileName of ['auth.json', 'config.toml']) {
      const filePath = path.join(mainRuntimeHome, fileName);
      if (fs.existsSync(filePath)) {
        previousMainRuntimeFiles.set(
          fileName,
          fs.readFileSync(filePath, 'utf8'),
        );
      }
    }
    fs.rmSync(mainRuntimeHome, { recursive: true, force: true });
    previousSettingsFile = fs.existsSync(CODEX_RUNTIME_SETTINGS_FILE)
      ? fs.readFileSync(CODEX_RUNTIME_SETTINGS_FILE, 'utf8')
      : null;
    fs.rmSync(CODEX_RUNTIME_SETTINGS_FILE, { force: true });
    process.env.CODEX_BIN = fakeCodexPath;
    process.env.OPENAI_API_KEY = 'host-key-must-not-leak';
    process.env.CODEX_API_KEY = 'host-codex-api-key-must-not-leak';
    process.env.CODEX_ACCESS_TOKEN = 'host-token-must-not-leak';
  });

  afterEach(() => {
    if (previousCodexBin === undefined) {
      delete process.env.CODEX_BIN;
    } else {
      process.env.CODEX_BIN = previousCodexBin;
    }
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
    if (previousCodexApiKey === undefined) {
      delete process.env.CODEX_API_KEY;
    } else {
      process.env.CODEX_API_KEY = previousCodexApiKey;
    }
    if (previousCodexAccessToken === undefined) {
      delete process.env.CODEX_ACCESS_TOKEN;
    } else {
      process.env.CODEX_ACCESS_TOKEN = previousCodexAccessToken;
    }
    fs.rmSync(groupSessionRoot, { recursive: true, force: true });
    fs.rmSync(mainRuntimeHome, { recursive: true, force: true });
    if (previousMainRuntimeFiles.size > 0) {
      fs.mkdirSync(mainRuntimeHome, { recursive: true });
      for (const [fileName, content] of previousMainRuntimeFiles) {
        fs.writeFileSync(path.join(mainRuntimeHome, fileName), content, {
          mode: 0o600,
        });
      }
    }
    fs.rmSync(fakeCodexPath, { force: true });
    if (previousSettingsFile === null) {
      fs.rmSync(CODEX_RUNTIME_SETTINGS_FILE, { force: true });
    } else {
      fs.mkdirSync(path.dirname(CODEX_RUNTIME_SETTINGS_FILE), {
        recursive: true,
      });
      fs.writeFileSync(CODEX_RUNTIME_SETTINGS_FILE, previousSettingsFile, {
        mode: 0o600,
      });
    }
  });

  test('persists model and reasoning settings for isolated runtime runs', () => {
    const defaults = getCodexRuntimeSettings();
    expect(defaults.model).toBe('gpt-5.6-sol');
    expect(defaults.reasoningEffort).toBe('medium');
    expect(CODEX_MODEL_PRESETS[0]).toBe('gpt-5.6-sol');

    const saved = saveCodexRuntimeSettings({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'high',
    });
    expect(saved.model).toBe('gpt-5.4-mini');
    expect(saved.reasoningEffort).toBe('high');

    const reread = getCodexRuntimeSettings();
    expect(reread.model).toBe('gpt-5.4-mini');
    expect(reread.reasoningEffort).toBe('high');
  });

  test('resolves user-level Codex install when service PATH omits it', () => {
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousCodexBinForTest = process.env.CODEX_BIN;
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
      if (previousCodexBinForTest === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousCodexBinForTest;
    }
  });

  test('logs into and out of an isolated CODEX_HOME', async () => {
    const initial = await getCodexRuntimeStatus(groupFolder);
    expect(initial.configured).toBe(false);
    expect(initial.runtimeHomeRelative).toBe(
      'data/sessions/codex-runtime-test/.codex',
    );
    expect(initial.model).toBe('gpt-5.6-sol');
    expect(initial.reasoningEffort).toBe('medium');
    expect(
      fs.readFileSync(path.join(runtimeHome, 'config.toml'), 'utf8'),
    ).toContain('cli_auth_credentials_store = "file"');

    const loggedIn = await loginCodexRuntimeWithApiKey(
      'sk-test-runtime-key',
      groupFolder,
    );
    expect(loggedIn.configured).toBe(true);
    expect(loggedIn.authFileExists).toBe(true);
    expect(fs.existsSync(path.join(runtimeHome, 'auth.json'))).toBe(true);

    const loggedOut = await logoutCodexRuntime(groupFolder);
    expect(loggedOut.configured).toBe(false);
    expect(fs.existsSync(path.join(runtimeHome, 'auth.json'))).toBe(false);
    expect(
      fs.readFileSync(path.join(runtimeHome, 'config.toml'), 'utf8'),
    ).toContain('cli_auth_credentials_store = "file"');
  });

  test('materializes service-managed credentials over stale workspace auth', () => {
    fs.mkdirSync(mainRuntimeHome, { recursive: true });
    fs.writeFileSync(
      path.join(mainRuntimeHome, 'auth.json'),
      '{"source":"main"}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(mainRuntimeHome, 'config.toml'),
      'model = "x"\ncli_auth_credentials_store = "keyring"\n',
      {
        mode: 0o600,
      },
    );

    const first = materializeCodexRuntimeCredentials(groupFolder);
    expect(first).toEqual({ authCopied: true, configCopied: true });
    expect(fs.readFileSync(path.join(runtimeHome, 'auth.json'), 'utf8')).toBe(
      '{"source":"main"}\n',
    );
    const config = fs.readFileSync(
      path.join(runtimeHome, 'config.toml'),
      'utf8',
    );
    expect(config).toContain('model = "x"');
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).not.toContain('cli_auth_credentials_store = "keyring"');

    fs.writeFileSync(path.join(runtimeHome, 'auth.json'), '{"source":"own"}\n');
    const second = materializeCodexRuntimeCredentials(groupFolder);
    expect(second).toEqual({ authCopied: true, configCopied: false });
    expect(fs.readFileSync(path.join(runtimeHome, 'auth.json'), 'utf8')).toBe(
      '{"source":"main"}\n',
    );
  });

  test('materializes credentials into the actual agent Codex home', () => {
    fs.mkdirSync(mainRuntimeHome, { recursive: true });
    fs.writeFileSync(
      path.join(mainRuntimeHome, 'auth.json'),
      '{"source":"main"}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(mainRuntimeHome, 'config.toml'),
      'model = "x"\n',
      {
        mode: 0o600,
      },
    );

    const agentHome = path.join(
      path.dirname(runtimeHome),
      'agents',
      'agent-a',
      '.codex',
    );
    const result = materializeCodexRuntimeCredentialsToHome(agentHome);

    expect(result).toEqual({ authCopied: true, configCopied: true });
    expect(fs.readFileSync(path.join(agentHome, 'auth.json'), 'utf8')).toBe(
      '{"source":"main"}\n',
    );
    expect(
      fs.readFileSync(path.join(agentHome, 'config.toml'), 'utf8'),
    ).toContain('cli_auth_credentials_store = "file"');
  });

  test('starts and observes an isolated device auth login', async () => {
    const login = await startCodexRuntimeDeviceAuthLogin(groupFolder);
    expect(login.status).toBe('pending');
    expect(login.verificationUri).toBe('https://auth.openai.com/codex/device');
    expect(login.userCode).toBe('ABCD-EFGH');
    expect(login.runtimeHomeRelative).toBe(
      'data/sessions/codex-runtime-test/.codex',
    );

    const pending = await getCodexRuntimeDeviceAuthLogin(login.id);
    expect(pending.status).toBe('pending');

    fs.writeFileSync(
      path.join(runtimeHome, 'auth.json'),
      JSON.stringify({ method: 'device-auth' }) + '\n',
    );

    const completed = await getCodexRuntimeDeviceAuthLogin(login.id);
    expect(completed.status).toBe('complete');

    const cancelled = await cancelCodexRuntimeDeviceAuthLogin(login.id);
    expect(cancelled.status).toBe('complete');
  });

  test('starts and observes an isolated browser auth login', async () => {
    const login = await startCodexRuntimeBrowserAuthLogin(groupFolder);
    expect(login.status).toBe('pending');
    expect(login.runtimeHomeRelative).toBe(
      'data/sessions/codex-runtime-test/.codex',
    );

    const pending = await getCodexRuntimeBrowserAuthLogin(login.id);
    expect(pending.status).toBe('pending');

    fs.writeFileSync(
      path.join(runtimeHome, 'auth.json'),
      JSON.stringify({ method: 'browser-auth' }) + '\n',
    );

    const completed = await getCodexRuntimeBrowserAuthLogin(login.id);
    expect(completed.status).toBe('complete');

    const cancelled = await cancelCodexRuntimeBrowserAuthLogin(login.id);
    expect(cancelled.status).toBe('complete');
  });
});

describe('Codex setup page', () => {
  test('keeps an explicit finish action after runtime auth succeeds', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'web/src/pages/SetupCodexPage.tsx'),
      'utf8',
    );

    expect(source).toContain('const handleFinish = async () =>');
    expect(source).toContain('onClick={handleFinish}');
    expect(source).toContain('保存 runtime 并进入消息通道');
    expect(source).toContain('await checkAuth();');
    expect(source).toContain("navigate('/setup/channels'");
  });
});

describe('Codex runtime setup UI', () => {
  test('shows a continue action instead of login controls when already configured', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/settings/CodexRuntimeSection.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('const continueConfigured = async () =>');
    expect(source).toContain('status?.configured ?');
    expect(source).toContain('Codex runtime 已经完成登录');
    expect(source).toContain('onClick={continueConfigured}');
    expect(source).toContain('继续下一步');
    expect(source).toContain('/api/config/codex/settings');
    expect(source).toContain('reasoningEffort');
    expect(source).toContain('模型');
    expect(source).toContain('const modelOptions = Array.from');
    expect(source).toContain("useState('gpt-5.6-sol')");
    expect(source).toContain("useState('medium')");
    expect(source).not.toContain('list="codex-model-presets"');

    const runnerSource = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/index.ts'),
      'utf8',
    );
    expect(runnerSource).toContain("|| 'gpt-5.6-sol'");
    expect(runnerSource).toContain("||\n  'medium'");
  });
});

describe('Codex fresh-session history injection', () => {
  test('injects persisted chat history when the main Codex session is fresh', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(source).toContain('const shouldInjectFreshHistory');
    expect(source).toContain('!existingRuntimeSessionId && !isRecovery');
    expect(source).toContain(
      '检测到当前底层 Codex session 是新的。以下是 HappyCodex 保存的最近对话记录',
    );
    expect(source).toContain(
      'Fresh session: injected recent conversation history into prompt',
    );
  });

  test('clears an overflowed Codex resume session before retrying with history', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(source).toContain('codex_resume_context_overflow:');
    expect(source).toContain(
      'Codex resume session overflow, clearing session for history-backed retry',
    );
    expect(source).toContain('await clearSessionRuntimeFiles(runtimeFolder);');
    expect(source).toContain('const runtimeFolder = effectiveGroup.folder;');
    expect(source).toContain('recoveryGroups.add(chatJid);');
    expect(source).toContain('return false;');
  });

  test('clears a stale Codex resume session when rollout files are missing', () => {
    const runnerSource = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/index.ts'),
      'utf8',
    );
    const hostSource = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(runnerSource).toContain('codex_resume_missing_session:');
    expect(hostSource).toContain('codex_resume_missing_session:');
    expect(hostSource).toContain(
      'Codex resume session missing rollout, clearing session for history-backed retry',
    );
    expect(hostSource).toContain(
      'Codex resume session missing rollout in conversation agent, clearing session for history-backed retry',
    );
    expect(hostSource).toContain(
      'const runtimeFolder = effectiveGroup.folder;',
    );
    expect(hostSource).toContain('delete sessions[runtimeFolder];');
    expect(hostSource).toContain(
      'deleteSession(effectiveGroup.folder, agentId);',
    );
  });
});
