import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildRuntimeContextPlan,
  syncHostRuntimeContext,
} from '../src/runtime-context-resolver.js';
import { buildRuntimeSkillsPrompt } from '../container/agent-runner/src/runtime-skills.js';

function writeFile(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeSkill(root: string, name: string): void {
  writeFile(path.join(root, name, 'SKILL.md'), `# ${name}`);
}

function fakeGroup(folder: string, ownerId: string, isHome = false) {
  return {
    name: folder,
    folder,
    added_at: '2026-05-18T00:00:00.000Z',
    created_by: ownerId,
    is_home: isHome,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-context-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('RuntimeContextResolver', () => {
  test('host sync links product skills but ignores external CLAUDE.md/rules/skills', () => {
    const external = path.join(tmp, 'external-claude');
    const dataDir = path.join(tmp, 'data');
    const projectRoot = path.join(tmp, 'project');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');

    writeFile(path.join(external, 'CLAUDE.md'), '# admin playbook');
    writeFile(path.join(external, 'rules', 'browser.md'), '# browser rule');
    makeSkill(path.join(external, 'skills'), 'external-skill');
    makeSkill(path.join(dataDir, 'builtin-skills'), 'builtin-skill');
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'project-skill');
    makeSkill(path.join(dataDir, 'skills', 'admin'), 'user-skill');

    const plan = buildRuntimeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      projectRoot,
      dataDir,
      groupSessionsDir: sessionDir,
    });
    const sync = syncHostRuntimeContext(plan, sessionDir);

    expect(sync.instructionsStatus).toBe('unavailable');
    expect(fs.existsSync(path.join(sessionDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, 'rules', 'browser.md'))).toBe(false);
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'builtin-skill'))).toBe(path.join(dataDir, 'builtin-skills', 'builtin-skill'));
    expect(fs.existsSync(path.join(sessionDir, 'skills', 'external-skill'))).toBe(false);
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'project-skill'))).toBe(path.join(projectRoot, 'container', 'skills', 'project-skill'));
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'user-skill'))).toBe(path.join(dataDir, 'skills', 'admin', 'user-skill'));
  });

  test('host sync preserves a real session CLAUDE.md and reports shadowed', () => {
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');
    writeFile(path.join(sessionDir, 'CLAUDE.md'), '# local');

    const plan = buildRuntimeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: sessionDir,
    });
    const sync = syncHostRuntimeContext(plan, sessionDir);

    expect(sync.instructionsStatus).toBe('shadowed');
    expect(sync.warnings).toContain('CLAUDE.md shadowed by session file but external sync is disabled');
    expect(fs.lstatSync(path.join(sessionDir, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
  });

  test('container plan does not expose external admin triad', () => {
    const adminPlan = buildRuntimeContextPlan({
      executionMode: 'container',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'main', '.claude'),
    });
    expect(adminPlan.audit.instructions).toMatchObject({
      status: 'unavailable',
    });
    expect(adminPlan.audit.rules).toMatchObject({
      status: 'unavailable',
      fileCount: 0,
    });
    expect(adminPlan.audit.skills.sources.some((source) => String(source.name) === 'external')).toBe(false);

    const userPlan = buildRuntimeContextPlan({
      executionMode: 'container',
      group: fakeGroup('alice-home', 'alice', true) as any,
      ownerHomeFolder: 'alice-home',
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'alice-home', '.claude'),
    });
    expect(userPlan.audit.instructions.status).toBe('unavailable');
    expect(userPlan.audit.instructions.sourcePath).toBeUndefined();
    expect(userPlan.audit.rules.status).toBe('unavailable');
    expect(userPlan.audit.skills.sources.some((source) => String(source.name) === 'external')).toBe(false);
  });

  test('runtime skills prompt can see workspace skills from the inherited workspace config surface', () => {
    const dataDir = path.join(tmp, 'data');
    const workspaceRoot = path.join(dataDir, 'groups', 'team-a');
    makeSkill(path.join(workspaceRoot, '.claude', 'skills'), 'workspace-skill');

    const plan = buildRuntimeContextPlan({
      executionMode: 'host',
      group: fakeGroup('team-a', 'alice') as any,
      ownerHomeFolder: 'alice-home',
      projectRoot: path.join(tmp, 'project'),
      dataDir,
      groupSessionsDir: path.join(tmp, 'sessions', 'team-a', '.claude'),
      workspaceRoot,
    });

    const prompt = buildRuntimeSkillsPrompt(plan.audit);

    expect(plan.audit.skills.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'workspace',
          sourcePath: path.join(workspaceRoot, '.claude', 'skills'),
        }),
      ]),
    );
    expect(prompt.includedSkills).toBe(1);
    expect(prompt.prompt).toContain('workspace-skill');
  });

  test('container plan maps workspace skills to the mounted workspace path', () => {
    const dataDir = path.join(tmp, 'data');
    const workspaceRoot = path.join(dataDir, 'groups', 'team-b');
    makeSkill(path.join(workspaceRoot, '.claude', 'skills'), 'container-workspace-skill');

    const plan = buildRuntimeContextPlan({
      executionMode: 'container',
      group: fakeGroup('team-b', 'alice') as any,
      ownerHomeFolder: 'alice-home',
      projectRoot: path.join(tmp, 'project'),
      dataDir,
      groupSessionsDir: path.join(tmp, 'sessions', 'team-b', '.claude'),
      workspaceRoot,
      containerWorkspaceRoot: '/workspace/group',
    });

    expect(plan.audit.skills.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'workspace',
          sourcePath: path.join(workspaceRoot, '.claude', 'skills'),
          runtimePath: '/workspace/group/.claude/skills',
          count: 1,
        }),
      ]),
    );
  });
});
