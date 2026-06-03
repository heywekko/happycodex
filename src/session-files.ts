/**
 * Session file cleanup — shared between the Web UI reset-session route and the
 * IM `/clear` slash command. Removes inherited agent runtime state under
 * `data/sessions/{folder}/.claude/` (or the agent-scoped subdir) except
 * `settings.json`, and removes Codex thread history under its runtime home
 * without touching isolated Codex auth/config/resource state.
 *
 * Errors on individual entries are logged and skipped so a single permission
 * problem (e.g. on a stale symlink) doesn't abort the whole reset.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

function getRuntimeDir(
  folder: string,
  runtimeDirName: '.claude' | '.codex',
  agentId?: string,
): string {
  return agentId
    ? path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, runtimeDirName)
    : path.join(DATA_DIR, 'sessions', folder, runtimeDirName);
}

function clearInheritedAgentDir(folder: string, agentId?: string): void {
  const runtimeDir = getRuntimeDir(folder, '.claude', agentId);
  if (!fs.existsSync(runtimeDir)) return;

  const keep = new Set(['settings.json']);
  for (const entry of fs.readdirSync(runtimeDir)) {
    if (keep.has(entry)) continue;
    try {
      fs.rmSync(path.join(runtimeDir, entry), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      logger.warn(
        { entry, folder, agentId, err },
        'Failed to remove session file, skipping',
      );
    }
  }
}

function clearCodexSessionHistory(folder: string, agentId?: string): void {
  const runtimeDir = getRuntimeDir(folder, '.codex', agentId);
  const sessionsDir = path.join(runtimeDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;
  try {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      { folder, agentId, err },
      'Failed to remove Codex session history, skipping',
    );
  }
}

export function clearSessionFiles(folder: string, agentId?: string): void {
  clearInheritedAgentDir(folder, agentId);
  clearCodexSessionHistory(folder, agentId);
}
