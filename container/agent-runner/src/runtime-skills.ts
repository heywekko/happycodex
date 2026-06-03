import fs from 'fs';
import path from 'path';

import type { RuntimeContextAudit } from './stream-event.types.js';

export interface RuntimeSkillsPrompt {
  prompt: string;
  includedSkills: number;
  totalSkills: number;
  tokens: number;
  warnings: string[];
  roots: string[];
}

export interface RuntimePluginRoot {
  type: 'local';
  path: string;
}

interface LoadedSkill {
  id: string;
  filePath: string;
  name: string;
  description: string;
}

const MAX_SKILLS = 64;
const MAX_DESCRIPTION_BYTES = 1_000;

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4);
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function collectRoots(audit?: RuntimeContextAudit, plugins: RuntimePluginRoot[] = []): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const addRoot = (root: string | undefined): void => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  };

  for (const source of audit?.skills.sources ?? []) {
    addRoot(source.runtimePath || source.sourcePath);
  }
  for (const plugin of plugins) {
    if (plugin.type !== 'local') continue;
    addRoot(path.join(plugin.path, 'skills'));
  }
  return roots;
}

function truncateDescription(value: string): string {
  const raw = Buffer.from(value.trim(), 'utf-8');
  if (raw.byteLength <= MAX_DESCRIPTION_BYTES) return value.trim();
  return `${raw.subarray(0, MAX_DESCRIPTION_BYTES).toString('utf-8').trim()}...`;
}

function parseFrontmatterField(content: string, field: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return '';
  const frontmatter = match[1];
  const line = frontmatter
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith(`${field}:`));
  if (!line) return '';
  return line
    .slice(line.indexOf(':') + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
}

function readSkillMetadata(id: string, filePath: string): LoadedSkill {
  const content = fs.readFileSync(filePath, 'utf-8');
  const name = parseFrontmatterField(content, 'name') || id;
  const description =
    parseFrontmatterField(content, 'description') ||
    'No description provided. Read SKILL.md before using this skill.';
  return {
    id,
    filePath,
    name: escapeHeading(name),
    description: truncateDescription(description),
  };
}

export function buildRuntimeSkillsPrompt(
  audit?: RuntimeContextAudit,
  plugins: RuntimePluginRoot[] = [],
): RuntimeSkillsPrompt {
  const skills = new Map<string, LoadedSkill>();
  const warnings: string[] = [];
  const roots = collectRoots(audit, plugins);

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      warnings.push(`Failed to read runtime skills root: ${root}`);
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const id = entry.name;
      const filePath = path.join(root, id, 'SKILL.md');
      if (!fs.existsSync(filePath)) continue;
      try {
        skills.set(id, readSkillMetadata(id, filePath));
      } catch {
        warnings.push(`Failed to read runtime skill: ${filePath}`);
      }
    }
  }

  const loaded = [...skills.values()].slice(0, MAX_SKILLS);
  const omitted = skills.size - loaded.length;
  if (omitted > 0) {
    warnings.push(`Skipped ${omitted} runtime skills beyond limit ${MAX_SKILLS}`);
  }

  if (loaded.length === 0) {
    return {
      prompt: '',
      includedSkills: 0,
      totalSkills: skills.size,
      tokens: 0,
      warnings,
      roots,
    };
  }

  const prompt = [
    '<runtime-skills>',
    'HappyCodex exposes these Codex-readable runtime skills. Use a skill only when its description directly matches the user request. Before using a skill, read the referenced SKILL.md file and follow its instructions.',
    ...loaded.map((skill) => [
      '',
      `## ${escapeHeading(skill.name)}`,
      `Description: ${skill.description}`,
      `Path: ${skill.filePath}`,
    ].join('\n')),
    '</runtime-skills>',
  ].join('\n');

  return {
    prompt,
    includedSkills: loaded.length,
    totalSkills: skills.size,
    tokens: estimateTokens(prompt),
    warnings,
    roots,
  };
}
