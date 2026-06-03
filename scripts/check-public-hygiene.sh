#!/usr/bin/env bash
set -euo pipefail

bad_paths='(^|/)(docs/project-brief\.md|node_modules|dist|tmp|\.happycodex|\.playwright-mcp|logs?)(/|$)|\.(log|sqlite|db)$|\.DS_Store$'

if git ls-files | grep -n -E "$bad_paths" >/tmp/happycodex-public-hygiene-paths.txt; then
  echo "Public hygiene check failed: tracked private/local/generated paths found." >&2
  cat /tmp/happycodex-public-hygiene-paths.txt >&2
  exit 1
fi

bad_content='/Users/[^/]+/|/private/var/folders/|\.codex/sessions|\.happycodex/runs|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN (OPENSSH|RSA|EC|DSA|PRIVATE) KEY-----'

if git grep -n -I -E "$bad_content" -- . ':(exclude)scripts/check-public-hygiene.sh' >/tmp/happycodex-public-hygiene-content.txt; then
  echo "Public hygiene check failed: tracked private paths or secret-like content found." >&2
  cat /tmp/happycodex-public-hygiene-content.txt >&2
  exit 1
fi

stale_repo_reference='github\.com/riba2534/happyclaw|riba2534/happyclaw#[0-9]+'
# README.md intentionally links to the upstream HappyClaw reference project.
if git grep -n -I -E "$stale_repo_reference" -- . ':(exclude)README.md' ':(exclude)scripts/check-public-hygiene.sh' >/tmp/happycodex-public-hygiene-repo-ref.txt; then
  echo "Public hygiene check failed: tracked source contains stale HappyClaw repository references." >&2
  cat /tmp/happycodex-public-hygiene-repo-ref.txt >&2
  exit 1
fi

stale_operational_identity='HappyClaw Host Tools Installer|Restart HappyClaw'
if git grep -n -I -E "$stale_operational_identity" -- scripts/install-host-tools.sh >/tmp/happycodex-public-hygiene-operational-identity.txt; then
  echo "Public hygiene check failed: operational scripts include stale HappyClaw identity." >&2
  cat /tmp/happycodex-public-hygiene-operational-identity.txt >&2
  exit 1
fi

package_files=()
while IFS= read -r path; do
  package_files+=("$path")
done < <(git ls-files '*package.json' '*package-lock.json')
if [[ ${#package_files[@]} -gt 0 ]] && git grep -n -I -E '@anthropic-ai|claude-agent-sdk|claude-code' -- "${package_files[@]}" >/tmp/happycodex-public-hygiene-runtime-deps.txt; then
  echo "Public hygiene check failed: tracked package manifests include stale Claude runtime dependencies." >&2
  cat /tmp/happycodex-public-hygiene-runtime-deps.txt >&2
  exit 1
fi

public_entry_files=()
for path in Makefile package.json web/package.json container/agent-runner/package.json; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    public_entry_files+=("$path")
  fi
done
stale_public_identity='riba2534/happyclaw|github\.com/riba2534/happyclaw|Claude Agent SDK|ensure-latest-sdk|update-sdk|@anthropic-ai|claude-code'
if [[ ${#public_entry_files[@]} -gt 0 ]] && git grep -n -I -E "$stale_public_identity" -- "${public_entry_files[@]}" >/tmp/happycodex-public-hygiene-identity.txt; then
  echo "Public hygiene check failed: public entry files include stale HappyClaw/Claude runtime identity." >&2
  cat /tmp/happycodex-public-hygiene-identity.txt >&2
  exit 1
fi

echo "Public hygiene check passed."
