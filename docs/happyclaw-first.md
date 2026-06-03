# HappyClaw-First Implementation Policy

HappyCodex is a HappyClaw-derived product. The product shell must be inherited from HappyClaw first, then adapted only where Codex requires a different runtime boundary.

## Non-Negotiable Rules

- HappyClaw is the source of truth for frontend routes, Hono/SQLite backend, auth, users, RBAC, audit logs, workspaces, tasks, files, plugins, skills, MCP, monitor surfaces, IM bindings, queueing, and host/container semantics.
- Do not reimplement a product-shell feature when HappyClaw already has it. Copy or restore the HappyClaw implementation instead.
- If current HappyCodex code conflicts with HappyClaw outside Codex runtime integration, delete or replace the HappyCodex code.
- Do not preserve stale Claude/provider UI just because a Codex equivalent is unfinished. Remove inaccurate surfaces or keep the inherited shell unchanged until the Codex runtime boundary is ready.
- Do not fix inherited HappyClaw product-shell behavior locally unless Codex makes inheritance impossible. Treat HappyClaw behavior as correct until direct evidence proves otherwise.
- Allowed divergence is limited to HappyCodex public identity, repository hygiene, and Codex-specific runner/runtime/config materialization.

## Required Workflow

1. Locate the equivalent HappyClaw file, route, component, store, migration, or runner behavior.
2. Restore that implementation as the baseline before changing anything.
3. Make only the smallest Codex-specific or identity-specific change required.
4. Run `HAPPYCLAW_REF=/path/to/happyclaw npm run check:happyclaw-baseline`.
5. If the baseline check requires a new exception, make it explicit and narrow. Broad allowlists are a failed change.

The current HappyCodex implementation is not a fallback baseline for product
shell work. When a product-shell file differs from HappyClaw, the default
action is to replace the HappyCodex file with HappyClaw's file, then reapply
only a proven Codex boundary or public identity change. Do not keep local
HappyCodex behavior because it is already present, easier to patch, or passes a
current test.

Baseline guard exceptions must describe actual remaining differences. Do not
leave a file in an allowed-diff list after it has become an extra
HappyCodex-only file, a missing HappyClaw-only file, or an identical inherited
file.

Allowed-diff files are pinned in `config/happyclaw-diff-budget.tsv` by the
HappyClaw blob hash and the HappyCodex blob hash. Updating that file is not a
routine way to silence the baseline check. Only update a diff budget entry
after reviewing the file against HappyClaw and confirming that every changed
line is required by the Codex runtime boundary, public identity, or repository
hygiene. If a change is product-shell behavior, restore HappyClaw instead of
updating the budget.

## Replacement-Only Reset

The HappyClaw-first reset is destructive for competing product-shell code. Old
HappyCodex implementations are not assets to keep improving when HappyClaw owns
the same surface. Delete or replace them before adding Codex changes.

Do not blend old HappyCodex product-shell code with copied HappyClaw behavior.
If a current file has local logic for users, sessions, workspaces, frontend
state, IM routing, tasks, files, plugins, skills, MCP, monitor, or queueing,
treat that logic as disposable unless it is already identical to HappyClaw or
is strictly required at the Codex runtime boundary.

When a copied HappyClaw path exposes a Claude/provider surface that Codex
cannot truthfully support yet, remove that surface at the narrow boundary
instead of building a HappyCodex-local compatibility feature. The absence of a
Codex replacement is not a reason to preserve stale Claude behavior.

## Migration Boundary

Codex replaces Claude Code at the runner/runtime boundary. It does not justify redesigning HappyClaw's product shell.

Keep these inherited HappyClaw areas unless Codex directly prevents them from working:

- Multi-user account and permission model.
- Workspace, conversation, task, file, memory, plugin, skill, MCP, and monitor surfaces.
- Web/IM routing semantics.
- Host/container execution split and service-managed runtime ownership.

Codex-specific work belongs in:

- Agent runner invocation and streaming event translation.
- Runtime home/config materialization.
- Session/resume persistence for Codex CLI.
- Codex resource import/sync where Claude-specific resources cannot be reused directly.

## Public Repository Hygiene

HappyCodex is intended to be public. Do not track local agent instructions, project-private briefs, runtime state, generated logs, dependency directories, build output, databases, local absolute paths, or secret-like content. Run `npm run check:public-hygiene` before committing.
