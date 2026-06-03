import type { RuntimeContextAudit } from './stream-event.types.js';

export function buildCodexRuntimeContextAudit(
  contextAuditBase: RuntimeContextAudit,
  runtimePrompt: RuntimeContextAudit['runtimePrompt'],
): RuntimeContextAudit {
  return {
    ...contextAuditBase,
    runtimePrompt,
    warnings: [...contextAuditBase.warnings],
  };
}

export function shouldEmitCodexContextAudit(
  contextAudit: RuntimeContextAudit,
): boolean {
  return contextAudit.warnings.length > 0;
}
