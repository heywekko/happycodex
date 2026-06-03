import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildRuntimeSkillsPrompt } from '../container/agent-runner/src/runtime-skills.js';
import type { RuntimeContextAudit } from '../shared/stream-event.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-runtime-skills-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(root: string, id: string, body: string, enabled = true): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, enabled ? 'SKILL.md' : 'SKILL.md.disabled'), body);
}

function skillBody(name: string, description: string, body: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
  ].join('\n');
}

function writePluginSkill(pluginRoot: string, id: string, body: string): void {
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0' }),
  );
  writeSkill(path.join(pluginRoot, 'skills'), id, body);
}

function auditForRoots(...roots: string[]): RuntimeContextAudit {
  return {
    executionMode: 'host',
    instructions: { status: 'unavailable' },
    rules: { status: 'unavailable', fileCount: 0 },
    skills: {
      sources: roots.map((runtimePath, index) => ({
        name: index === 0 ? 'builtin' : 'user',
        runtimePath,
      })),
    },
    runtimePrompt: { totalBytes: 0, files: [] },
    warnings: [],
  };
}

describe('buildRuntimeSkillsPrompt', () => {
  test('loads enabled runtime skills and skips disabled skills', () => {
    const root = path.join(tmp, 'skills');
    writeSkill(
      root,
      'enabled-skill',
      skillBody('enabled-skill', 'Use this when enabled.', '# Enabled\n\nFULL BODY'),
    );
    writeSkill(root, 'disabled-skill', '# Disabled', false);

    const result = buildRuntimeSkillsPrompt(auditForRoots(root));

    expect(result.includedSkills).toBe(1);
    expect(result.prompt).toContain('enabled-skill');
    expect(result.prompt).toContain('Use this when enabled.');
    expect(result.prompt).toContain(path.join(root, 'enabled-skill', 'SKILL.md'));
    expect(result.prompt).not.toContain('FULL BODY');
    expect(result.prompt).not.toContain('disabled-skill');
  });

  test('lets later runtime roots override earlier skill ids', () => {
    const builtin = path.join(tmp, 'builtin');
    const user = path.join(tmp, 'user');
    writeSkill(
      builtin,
      'review',
      skillBody('review', 'Builtin review behavior.', '# Builtin Review'),
    );
    writeSkill(
      user,
      'review',
      skillBody('review', 'User review behavior.', '# User Review'),
    );

    const result = buildRuntimeSkillsPrompt(auditForRoots(builtin, user));

    expect(result.includedSkills).toBe(1);
    expect(result.prompt).toContain('User review behavior.');
    expect(result.prompt).toContain(path.join(user, 'review', 'SKILL.md'));
    expect(result.prompt).not.toContain('Builtin review behavior.');
    expect(result.prompt).not.toContain('# User Review');
    expect(result.prompt).not.toContain('# Builtin Review');
  });

  test('loads enabled skills from local plugin runtime roots', () => {
    const pluginRoot = path.join(tmp, 'plugin');
    writePluginSkill(
      pluginRoot,
      'plugin-skill',
      skillBody(
        'plugin-skill',
        'Use plugin behavior when requested.',
        '# Plugin Skill\n\nFULL PLUGIN BODY',
      ),
    );

    const result = buildRuntimeSkillsPrompt(auditForRoots(), [{ type: 'local', path: pluginRoot }]);

    expect(result.includedSkills).toBe(1);
    expect(result.prompt).toContain('plugin-skill');
    expect(result.prompt).toContain('Use plugin behavior when requested.');
    expect(result.prompt).toContain(path.join(pluginRoot, 'skills', 'plugin-skill', 'SKILL.md'));
    expect(result.prompt).not.toContain('FULL PLUGIN BODY');
  });
});
