# HappyClaw Parity Plan

HappyCodex is a HappyClaw-derived product. Parity means the product shell keeps
HappyClaw's behavior unless a difference is required by Codex runtime
integration, public project identity, or public repository hygiene.

## Product Shell Inheritance

These areas should stay inherited from HappyClaw:

- React/Vite route structure, page layout, navigation, and stores.
- Hono routes, SQLite schema, auth, users, invite codes, RBAC, audit logs, and
  session management.
- Workspaces, conversations, tasks, files, memory surfaces, skills, plugins,
  MCP, monitor pages, IM bindings, queueing, and host/container execution
  semantics.

Do not reimplement these surfaces locally. If HappyCodex drifts from HappyClaw
outside an allowed boundary, restore the HappyClaw implementation first.

This is a replacement-only migration, not an incremental merge with the old
HappyCodex shell. Current HappyCodex product-shell code should be discarded
when it competes with HappyClaw. Keep current code only when it is a narrow
Codex runtime adapter, public identity change, repository-hygiene change, or an
already-inherited HappyClaw implementation.

## Allowed HappyCodex Differences

Allowed differences must stay narrow:

- Public identity: project name, package metadata, logos, user-facing product
  name, repository hygiene, and public documentation.
- Codex runtime setup: isolated runtime home creation, login/status/logout, and
  service-managed runtime state.
- Runner boundary: `codex exec --json`, JSONL event translation, final-answer
  capture, thread/session resume, and Codex-specific environment isolation.
- Codex resource import/sync: plugins, skills, rules, hooks, MCP, and related
  runtime resources when Codex needs different materialization.

Claude/provider product surfaces that cannot be accurate for Codex should be
removed rather than preserved as compatibility UI.

## Current Parity Target

The minimum parity target is not the old smoke test. It must prove:

- The copied HappyClaw frontend builds in HappyCodex.
- Initial admin setup and login work through the inherited product shell.
- SQLite state remains under `data/`.
- Users, invite codes, RBAC, audit logs, disabled users, password reset, and
  session revocation remain inherited.
- Admin home workspace and member isolated workspaces exist.
- Each workspace uses a service-managed Codex runtime home.
- Codex login/status targets the isolated runtime, not the operator's shell.
- Browser chat runs through the copied frontend and Codex runner boundary.
- IM bindings keep HappyClaw semantics; channel-specific runtime changes must
  be made at the runner or channel adapter boundary.
- Codex session resume works per workspace.
- Host resources are imported or synced deliberately, not silently reused from
  the operator's personal runtime.

## Verification Gates

Run these before and after product-shell changes:

```bash
HAPPYCLAW_REF=/path/to/happyclaw npm run check:happyclaw-baseline
npm run check:public-hygiene
npm run typecheck
cd web && npm run build
```

Use focused tests for Codex-specific behavior:

```bash
npx vitest run tests/codex-cli.test.ts tests/codex-runtime.test.ts
```

Unexpected product-shell drift is a failed change. Fix it by restoring
HappyClaw-derived code or by documenting a narrow Codex-specific exception in
`scripts/check-happyclaw-baseline.sh`.

If `check:happyclaw-baseline` reports changed allowed-diff content, first
compare the file with HappyClaw and decide whether the HappyCodex change is a
true Codex/runtime, public-identity, or repository-hygiene boundary. If it is
not, restore the HappyClaw version. Update `config/happyclaw-diff-budget.tsv`
only after that review, because the budget pins the exact reviewed drift and
prevents allowed files from silently accumulating local product-shell behavior.
