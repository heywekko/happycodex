import fs from 'fs';
import path from 'path';

import type { RuntimeContextAudit } from './stream-event.types.js';
import type { RegisteredGroup } from './types.js';

export interface RuntimeContextPlanArgs {
  executionMode: 'host' | 'container';
  group: RegisteredGroup;
  ownerHomeFolder?: string;
  projectRoot: string;
  dataDir: string;
  groupSessionsDir?: string;
  workspaceRoot?: string;
  containerWorkspaceRoot?: string;
  mountUserSkills?: boolean;
}

export interface RuntimeContextPlan {
  executionMode: 'host' | 'container';
  builtinSkillsDir: string;
  projectSkillsDir: string;
  userSkillsDir?: string;
  workspaceSkillsDir?: string;
  audit: RuntimeContextAudit;
}

export interface HostRuntimeContextSyncResult {
  instructionsStatus: RuntimeContextAudit['instructions']['status'];
  warnings: string[];
}

function exists(p: string | undefined): p is string {
  return !!p && fs.existsSync(p);
}

function countChildDirs(dir: string | undefined): number {
  if (!exists(dir)) return 0;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .length;
  } catch {
    return 0;
  }
}

function removePath(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function linkEntries(
  sourceDir: string | undefined,
  targetDir: string,
  include: (entry: fs.Dirent) => boolean,
): void {
  if (!exists(sourceDir)) return;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!include(entry)) continue;
    const linkPath = path.join(targetDir, entry.name);
    removePath(linkPath);
    try {
      fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
    } catch {
      /* best effort */
    }
  }
}

export function buildRuntimeContextPlan(args: RuntimeContextPlanArgs): RuntimeContextPlan {
  const ownerId = args.group.created_by;
  const builtinSkillsDir =
    args.executionMode === 'container'
      ? '/opt/builtin-skills'
      : path.join(args.dataDir, 'builtin-skills');
  const projectSkillsDir = path.join(args.projectRoot, 'container', 'skills');
  const userSkillsDir =
    args.mountUserSkills !== false && ownerId
      ? path.join(args.dataDir, 'skills', ownerId)
      : undefined;
  const workspaceSkillsDir = args.workspaceRoot
    ? path.join(args.workspaceRoot, '.claude', 'skills')
    : undefined;
  const workspaceSkillsRuntime =
    args.executionMode === 'container'
      ? path.join(args.containerWorkspaceRoot ?? '/workspace/group', '.claude', 'skills')
      : workspaceSkillsDir;

  const hostSkillsRuntime = args.groupSessionsDir
    ? path.join(args.groupSessionsDir, 'skills')
    : undefined;

  const warnings: string[] = [];

  const audit: RuntimeContextAudit = {
    executionMode: args.executionMode,
    instructions: {
      status: 'unavailable',
    },
    rules: {
      status: 'unavailable',
      fileCount: 0,
    },
    skills: {
      sources: [
        {
          name: 'builtin',
          sourcePath: builtinSkillsDir,
          runtimePath: args.executionMode === 'container'
            ? '/home/node/.claude/skills'
            : hostSkillsRuntime,
          count: countChildDirs(args.executionMode === 'container' ? undefined : builtinSkillsDir),
        },
        {
          name: 'project',
          sourcePath: projectSkillsDir,
          runtimePath: args.executionMode === 'container'
            ? '/workspace/project-skills'
            : hostSkillsRuntime,
          count: countChildDirs(projectSkillsDir),
        },
        ...(userSkillsDir ? [{
          name: 'user' as const,
          sourcePath: userSkillsDir,
          runtimePath: args.executionMode === 'container'
            ? '/workspace/user-skills'
            : hostSkillsRuntime,
          count: countChildDirs(userSkillsDir),
        }] : []),
        ...(workspaceSkillsDir ? [{
          name: 'workspace' as const,
          sourcePath: workspaceSkillsDir,
          runtimePath: workspaceSkillsRuntime,
          count: countChildDirs(workspaceSkillsDir),
        }] : []),
      ],
    },
    runtimePrompt: { totalBytes: 0, files: [] },
    warnings,
  };

  return {
    executionMode: args.executionMode,
    builtinSkillsDir,
    projectSkillsDir,
    userSkillsDir,
    workspaceSkillsDir,
    audit,
  };
}

export function syncHostRuntimeContext(
  plan: RuntimeContextPlan,
  groupSessionsDir: string,
): HostRuntimeContextSyncResult {
  const warnings = [...plan.audit.warnings];
  const skillsDir = path.join(groupSessionsDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      removePath(path.join(skillsDir, entry.name));
    }
  }
  const includeSkill = (entry: fs.Dirent) => entry.isDirectory() || entry.isSymbolicLink();
  linkEntries(plan.builtinSkillsDir, skillsDir, includeSkill);
  linkEntries(plan.projectSkillsDir, skillsDir, includeSkill);
  linkEntries(plan.userSkillsDir, skillsDir, includeSkill);
  linkEntries(plan.workspaceSkillsDir, skillsDir, includeSkill);

  const rulesDir = path.join(groupSessionsDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.isFile() || entry.isDirectory()) {
      removePath(path.join(rulesDir, entry.name));
    }
  }

  let instructionsStatus = plan.audit.instructions.status;
  const sessionClaudeMd = path.join(groupSessionsDir, 'CLAUDE.md');
  try {
    const st = fs.lstatSync(sessionClaudeMd);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(sessionClaudeMd);
    } else {
      instructionsStatus = 'shadowed';
      warnings.push('CLAUDE.md shadowed by session file but external sync is disabled');
    }
  } catch {
    /* no session CLAUDE.md */
  }

  return { instructionsStatus, warnings };
}
