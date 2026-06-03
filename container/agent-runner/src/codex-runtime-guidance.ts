import fs from 'fs';
import path from 'path';

const BEGIN_MARKER = '<!-- BEGIN HAPPYCODEX RUNTIME GUIDANCE -->';
const END_MARKER = '<!-- END HAPPYCODEX RUNTIME GUIDANCE -->';

export interface SyncCodexRuntimeGuidanceOptions {
  codexHome: string;
  runtimeGuidance: string;
}

export interface SyncCodexRuntimeGuidanceResult {
  agentsPath: string;
  bytes: number;
}

function stripManagedBlock(content: string): string {
  const escapedBegin = BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\n?${escapedBegin}[\\s\\S]*?${escapedEnd}\\n?`,
    'g',
  );
  return content.replace(pattern, '\n').trimEnd();
}

export function syncCodexRuntimeGuidance(
  options: SyncCodexRuntimeGuidanceOptions,
): SyncCodexRuntimeGuidanceResult {
  fs.mkdirSync(options.codexHome, { recursive: true, mode: 0o700 });
  const agentsPath = path.join(options.codexHome, 'AGENTS.md');
  const existing = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, 'utf-8')
    : '';
  const base = stripManagedBlock(existing);
  const guidance = options.runtimeGuidance.trim();

  const managedBlock = guidance
    ? [
        BEGIN_MARKER,
        '# HappyCodex Runtime Guidance',
        '',
        guidance,
        END_MARKER,
      ].join('\n')
    : '';
  const next = [base, managedBlock].filter(Boolean).join('\n\n');

  if (next) {
    fs.writeFileSync(agentsPath, `${next}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(agentsPath, 0o600);
    } catch {
      /* chmod is best-effort on filesystems that do not preserve modes. */
    }
  } else {
    fs.rmSync(agentsPath, { force: true });
  }

  return {
    agentsPath,
    bytes: Buffer.byteLength(next, 'utf-8'),
  };
}
