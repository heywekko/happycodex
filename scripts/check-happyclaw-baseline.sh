#!/usr/bin/env bash
set -euo pipefail

ref="${HAPPYCLAW_REF:-}"
if [[ -z "$ref" ]]; then
  echo "HAPPYCLAW_REF is required." >&2
  exit 1
fi

if [[ ! -d "$ref/.git" ]]; then
  echo "HAPPYCLAW_REF must point to a HappyClaw Git checkout: $ref" >&2
  exit 1
fi

current_files="$(mktemp)"
ref_files="$(mktemp)"
untracked_files="$(mktemp)"
trap 'rm -f "$current_files" "$ref_files" "$untracked_files"' EXIT
diff_budget_file="config/happyclaw-diff-budget.tsv"
extra_budget_file="config/happycodex-extra-budget.tsv"

git ls-files | sort >"$current_files"
git ls-files --others --exclude-standard | sort >"$untracked_files"
git -C "$ref" ls-files | sort >"$ref_files"

contains_path() {
  local path="$1"
  local list="$2"
  grep -qxF "$path" "$list"
}

extract_allowed_case_paths() {
  local function_name="$1"
  awk -v fn="$function_name" '
    $0 ~ "^" fn "\\(\\) \\{" {
      in_func = 1
      next
    }
    in_func && /case "\$1" in/ {
      in_case = 1
      next
    }
    in_func && in_case && /^[[:space:]]*\*\)/ {
      exit
    }
    in_func && in_case {
      line = $0
      sub(/#.*/, "", line)
      gsub(/\\/, "", line)
      gsub(/\|/, "\n", line)
      gsub(/\)/, "\n", line)
      n = split(line, parts, "\n")
      for (i = 1; i <= n; i++) {
        entry = parts[i]
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", entry)
        if (entry != "" && entry !~ /[[:space:]();*]/) print entry
      }
    }
  ' "$0" | sort -u
}

read_diff_budget_entry() {
  local path="$1"
  awk -F '\t' -v p="$path" '
    $0 !~ /^#/ && $1 == p {
      print $0
      found = 1
      exit
    }
    END {
      if (!found) exit 1
    }
  ' "$diff_budget_file"
}

read_extra_budget_entry() {
  local path="$1"
  awk -F '\t' -v p="$path" '
    $0 !~ /^#/ && $1 == p {
      print $0
      found = 1
      exit
    }
    END {
      if (!found) exit 1
    }
  ' "$extra_budget_file"
}

is_allowed_extra() {
  case "$1" in
    AGENTS.md | \
    config/happycodex-extra-budget.tsv | \
    config/happyclaw-diff-budget.tsv | \
    docs/happyclaw-first.md | \
    docs/happyclaw-parity.md | \
    config/happyclaw-route-allowlist.txt | \
    container/agent-runner/src/codex-cli.ts | \
    container/agent-runner/src/codex-prompt.ts | \
    container/agent-runner/src/codex-runtime-adapter.ts | \
    container/agent-runner/src/codex-runtime-guidance.ts | \
    container/agent-runner/src/runtime-skills.ts | \
    src/codex-mcp-config.ts | \
    scripts/check-happyclaw-baseline.sh | \
    scripts/check-happyclaw-routes.mjs | \
    scripts/check-public-hygiene.sh | \
    tests/codex-cli.test.ts | \
    tests/sdk-query.test.ts | \
    tests/codex-mcp-config.test.ts | \
    tests/runtime-skills.test.ts | \
    tests/routes-mcp-servers.test.ts | \
    tests/routes-skills-search.test.ts | \
    tests/routes-workspace-skills-install.test.ts | \
    src/codex-runtime.ts | \
    src/runtime-context-resolver.ts | \
    tests/codex-runtime.test.ts | \
    tests/routes-codex-config-auth.test.ts | \
    tests/runtime-context-resolver.test.ts | \
    web/src/components/settings/CodexRuntimeSection.tsx | \
    web/src/pages/SetupCodexPage.tsx)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_allowed_missing() {
  case "$1" in
    CLAUDE.md | \
    docs/claude-code-plugin-automation-design.md | \
    docs/screenshots/chat-image-gen.png | \
    docs/screenshots/chat-markdown.png | \
    docs/screenshots/chat-tool-tracking.png | \
    docs/screenshots/feishu-card-reply.png | \
    docs/screenshots/feishu-chat.png | \
    docs/screenshots/mobile-groups.png | \
    docs/screenshots/mobile-login.png | \
    docs/screenshots/mobile-monitor.png | \
    docs/screenshots/mobile-settings.png | \
    docs/screenshots/setup-providers.png | \
    docs/screenshots/setup-wizard.png | \
    container/agent-runner/src/agent-definitions.ts | \
    container/skills/install-skill/SKILL.md | \
    container/agent-runner/src/history-image-prune.ts | \
    container/agent-runner/src/mcp-tools.ts | \
    container/agent-runner/src/session-history.ts | \
    container/agent-runner/src/stream-processor.ts | \
    container/agent-runner/src/utils.ts | \
    src/claude-context-resolver.ts | \
    src/routes/agent-definitions.ts | \
    src/provider-pool.ts | \
    tests/agent-output-parser.test.ts | \
    tests/history-image-prune.test.ts | \
    tests/mcp-send-message-taskid.test.ts | \
    tests/provider-switch-predictor.test.ts | \
    tests/provider-switch-session.test.ts | \
    tests/session-history.test.ts | \
    tests/session-provider-binding.test.ts | \
    tests/stream-processor.test.ts | \
    tests/claude-context-resolver.test.ts | \
    web/src/components/monitor/ProviderSwitcher.tsx | \
    web/src/components/settings/BalancingSettings.tsx | \
    web/src/components/settings/ClaudeProviderSection.tsx | \
    web/src/components/settings/ProviderEditor.tsx | \
    web/src/components/settings/ProviderList.tsx | \
    web/src/components/settings/UsageBars.tsx | \
    web/src/pages/AgentDefinitionsPage.tsx | \
    web/src/pages/SetupProvidersPage.tsx | \
    web/src/stores/agent-definitions.ts)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_forbidden_current() {
  case "$1" in
    container/agent-runner/src/agent-definitions.ts | \
    container/agent-runner/src/history-image-prune.ts | \
    container/agent-runner/src/mcp-tools.ts | \
    container/agent-runner/src/session-history.ts | \
    container/agent-runner/src/stream-processor.ts | \
    container/agent-runner/src/utils.ts | \
    container/skills/install-skill/SKILL.md | \
    src/claude-context-resolver.ts | \
    src/provider-pool.ts | \
    src/routes/agent-definitions.ts | \
    tests/agent-output-parser.test.ts | \
    tests/claude-context-resolver.test.ts | \
    tests/history-image-prune.test.ts | \
    tests/mcp-send-message-taskid.test.ts | \
    tests/provider-switch-predictor.test.ts | \
    tests/provider-switch-session.test.ts | \
    tests/session-history.test.ts | \
    tests/session-provider-binding.test.ts | \
    tests/stream-processor.test.ts | \
    web/src/components/monitor/ProviderSwitcher.tsx | \
    web/src/components/settings/BalancingSettings.tsx | \
    web/src/components/settings/ClaudeProviderSection.tsx | \
    web/src/components/settings/ProviderEditor.tsx | \
    web/src/components/settings/ProviderList.tsx | \
    web/src/components/settings/UsageBars.tsx | \
    web/src/pages/AgentDefinitionsPage.tsx | \
    web/src/pages/SetupProvidersPage.tsx | \
    web/src/stores/agent-definitions.ts)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_allowed_diff() {
  case "$1" in
    .gitignore | \
    Makefile | \
    README.md | \
    config/global-claude-md.template.md | \
    docs/API.md | \
    container/Dockerfile | \
    container/entrypoint.sh | \
    container/agent-runner/package.json | \
    container/agent-runner/prompts/agent-override.md | \
    container/agent-runner/prompts/background-tasks.md | \
    container/agent-runner/prompts/channels/feishu.md | \
    container/agent-runner/prompts/channels/telegram.md | \
    container/agent-runner/prompts/skill-routing.md | \
    container/agent-runner/prompts/security-rules.md | \
    container/agent-runner/prompts/memory-system.guest.md | \
    container/agent-runner/prompts/memory-system.home.md | \
    container/agent-runner/src/index.ts | \
    container/agent-runner/src/stream-event.types.ts | \
    container/agent-runner/src/types.ts | \
    container/build.sh | \
    container/skills/post-test-cleanup/SKILL.md | \
    package.json | \
    src/agent-output-parser.ts | \
    src/commands.ts | \
    src/config.ts | \
    src/container-runner.ts | \
    src/conversation-history.ts | \
    src/agent-capabilities.ts | \
    src/db.ts | \
    src/group-queue.ts | \
    src/index.ts | \
    src/plugin-command-index.ts | \
    src/plugin-dependency-check.ts | \
    src/plugin-manifest.ts | \
    src/plugin-expander-core.ts | \
    src/plugin-inline-bash.ts | \
    src/plugin-utils.ts | \
    src/routes/auth.ts | \
    src/routes/bug-report.ts | \
    src/routes/config.ts | \
    src/routes/groups.ts | \
    src/routes/mcp-servers.ts | \
    src/routes/monitor.ts | \
    src/routes/plugins.ts | \
    src/routes/tasks.ts | \
    src/runtime-config.ts | \
    src/sdk-query.ts | \
    src/schemas.ts | \
    src/session-files.ts | \
    src/stream-event.types.ts | \
    src/task-scheduler.ts | \
    src/web.ts | \
    src/whatsapp.ts | \
    scripts/install-host-tools.sh | \
    shared/stream-event.ts | \
    tests/container-runner-plugin-mount.test.ts | \
    tests/conversation-agent-warm-lifecycle.test.ts | \
    tests/plugin-expander-routing-bugs.test.ts | \
    tests/plugin-expander-runtime-owner-divergence.test.ts | \
    tests/prompt-loader.test.ts | \
    tests/route-restore.test.ts | \
    tests/session-files.test.ts | \
    web/index.html | \
    web/package.json | \
    web/public/icons/logo-text.svg | \
    web/src/components/chat/ShareCardRenderer.tsx | \
    web/src/components/chat/ContainerEnvPanel.tsx | \
    web/src/components/chat/ChatView.tsx | \
    web/src/components/chat/MessageBubble.tsx | \
    web/src/components/chat/StreamingDisplay.tsx | \
    web/src/components/common/BugReportDialog.tsx | \
    web/src/components/common/LogoLoading.tsx | \
    web/src/components/auth/AuthGuard.tsx | \
    web/src/components/layout/AppLayout.tsx | \
    web/src/components/layout/UnifiedSidebar.tsx | \
    web/src/components/monitor/GroupStatusCard.tsx | \
    web/src/components/monitor/SystemInfo.tsx | \
    web/src/components/tasks/CreateTaskForm.tsx | \
    web/src/components/settings/AboutSection.tsx | \
    web/src/components/settings/AppearanceSection.tsx | \
    web/src/components/settings/BindingsSection.tsx | \
    web/src/components/settings/ProfileSection.tsx | \
    web/src/components/settings/SettingsNav.tsx | \
    web/src/components/settings/SystemSettingsSection.tsx | \
    web/src/components/settings/types.ts | \
    web/src/App.tsx | \
    web/src/pages/ChatPage.tsx | \
    web/src/pages/LoginPage.tsx | \
    web/src/pages/MemoryPage.tsx | \
    web/src/pages/MonitorPage.tsx | \
    web/src/pages/PluginsPage.tsx | \
    web/src/pages/SettingsPage.tsx | \
    web/src/pages/SetupPage.tsx | \
    web/src/stores/auth.ts | \
    web/src/stores/container-env.ts | \
    web/src/stores/monitor.ts | \
    web/src/stores/chat.ts | \
    web/src/stream-event.types.ts | \
    web/src/styles/globals.css | \
    web/vite.config.ts)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

unexpected_extra="$(
  comm -23 "$current_files" "$ref_files" | while IFS= read -r path; do
    if ! is_allowed_extra "$path"; then
      echo "$path"
    fi
  done
)"
unexpected_missing="$(
  comm -13 "$current_files" "$ref_files" | while IFS= read -r path; do
    if ! is_allowed_missing "$path"; then
      echo "$path"
    fi
  done
)"
forbidden_current="$(
  cat "$current_files" "$untracked_files" | sort -u | while IFS= read -r path; do
    if is_forbidden_current "$path"; then
      echo "$path"
    fi
  done
)"

if [[ -n "$forbidden_current" ]]; then
  echo "Forbidden stale HappyClaw product-surface files present in HappyCodex:" >&2
  echo "$forbidden_current" >&2
  exit 1
fi

if [[ ! -f "$diff_budget_file" ]]; then
  echo "HappyClaw diff budget file is required: $diff_budget_file" >&2
  exit 1
fi

if [[ ! -f "$extra_budget_file" ]]; then
  echo "HappyCodex extra budget file is required: $extra_budget_file" >&2
  exit 1
fi

forbidden_content_pattern='AgentDefinitionsPage|agentDefinitionsRoutes|ClaudeProviderSection|ProviderSwitcher|ProviderList|BalancingSettings|UsageBars|SetupProvidersPage|ClaudeContextAudit|buildClaudeContextPlan|syncHostClaudeContext|claude-context-resolver|getClaudeProviderConfig|getEnabledProviders|UnifiedProvider|ClaudeConfigSchema|BalancingConfigSchema|providerPool|setProviderOverride|willClearSessionOnProviderSwitch|selectedProviderId|selectedProviderName|switch-provider|isProviderFailureResult|isApiError|hasProviderFailureOutput|providerFailure|API_ERROR_PATTERNS|CLAUDE_LIMIT_PHRASE_PATTERNS'
if git grep -n -I -E "$forbidden_content_pattern" -- src web container tests >/tmp/happycodex-forbidden-surfaces.txt; then
  echo "Forbidden stale HappyClaw product-surface references present in HappyCodex:" >&2
  cat /tmp/happycodex-forbidden-surfaces.txt >&2
  exit 1
fi

stale_allowed_extra="$(
  extract_allowed_case_paths is_allowed_extra | while IFS= read -r path; do
    if [[ "$path" == "$extra_budget_file" ]]; then
      continue
    fi
    if ! contains_path "$path" "$current_files" || contains_path "$path" "$ref_files"; then
      echo "$path"
    fi
  done
)"
unexpected_allowed_extra_budget="$(
  extract_allowed_case_paths is_allowed_extra | while IFS= read -r path; do
    if [[ "$path" == "$extra_budget_file" ]]; then
      continue
    fi
    if ! contains_path "$path" "$current_files" || contains_path "$path" "$ref_files"; then
      continue
    fi
    if ! budget_entry="$(read_extra_budget_entry "$path")"; then
      echo "$path missing-budget"
      continue
    fi
    IFS=$'\t' read -r budget_path expected_current_hash <<<"$budget_entry"
    actual_current_hash="$(git hash-object -- "$path")"
    if [[ "$budget_path" != "$path" || "$actual_current_hash" != "$expected_current_hash" ]]; then
      echo "$path expected-current=$expected_current_hash actual-current=$actual_current_hash"
    fi
  done
)"
stale_extra_budget_entries="$(
  awk -F '\t' '$0 !~ /^#/ && NF >= 2 { print $1 }' "$extra_budget_file" | while IFS= read -r path; do
    if [[ "$path" == "$extra_budget_file" ]]; then
      echo "$path"
      continue
    fi
    if ! is_allowed_extra "$path"; then
      echo "$path"
      continue
    fi
    if ! contains_path "$path" "$current_files" || contains_path "$path" "$ref_files"; then
      echo "$path"
    fi
  done
)"
stale_allowed_missing="$(
  extract_allowed_case_paths is_allowed_missing | while IFS= read -r path; do
    if contains_path "$path" "$current_files" || ! contains_path "$path" "$ref_files"; then
      echo "$path"
    fi
  done
)"
stale_allowed_diff="$(
  extract_allowed_case_paths is_allowed_diff | while IFS= read -r path; do
    if ! contains_path "$path" "$current_files" || ! contains_path "$path" "$ref_files"; then
      echo "$path"
      continue
    fi
    if cmp -s "$path" "$ref/$path"; then
      echo "$path"
    fi
  done
)"
unexpected_allowed_diff_budget="$(
  extract_allowed_case_paths is_allowed_diff | while IFS= read -r path; do
    if ! contains_path "$path" "$current_files" || ! contains_path "$path" "$ref_files"; then
      continue
    fi
    if cmp -s "$path" "$ref/$path"; then
      continue
    fi
    if ! budget_entry="$(read_diff_budget_entry "$path")"; then
      echo "$path missing-budget"
      continue
    fi
    IFS=$'\t' read -r budget_path expected_ref_hash expected_current_hash <<<"$budget_entry"
    actual_ref_hash="$(git hash-object -- "$ref/$path")"
    actual_current_hash="$(git hash-object -- "$path")"
    if [[ "$budget_path" != "$path" || "$actual_ref_hash" != "$expected_ref_hash" || "$actual_current_hash" != "$expected_current_hash" ]]; then
      echo "$path expected-ref=$expected_ref_hash actual-ref=$actual_ref_hash expected-current=$expected_current_hash actual-current=$actual_current_hash"
    fi
  done
)"
stale_diff_budget_entries="$(
  awk -F '\t' '$0 !~ /^#/ && NF >= 3 { print $1 }' "$diff_budget_file" | while IFS= read -r path; do
    if ! is_allowed_diff "$path"; then
      echo "$path"
      continue
    fi
    if ! contains_path "$path" "$current_files" || ! contains_path "$path" "$ref_files"; then
      echo "$path"
      continue
    fi
    if cmp -s "$path" "$ref/$path"; then
      echo "$path"
    fi
  done
)"

if [[ -n "$stale_allowed_extra" ]]; then
  echo "Stale allowed extra files; remove these from is_allowed_extra:" >&2
  echo "$stale_allowed_extra" >&2
  exit 1
fi

if [[ -n "$unexpected_allowed_extra_budget" ]]; then
  echo "Allowed extra content changed; remove the file or update $extra_budget_file after review:" >&2
  echo "$unexpected_allowed_extra_budget" >&2
  exit 1
fi

if [[ -n "$stale_extra_budget_entries" ]]; then
  echo "Stale HappyCodex extra budget entries; remove these from $extra_budget_file:" >&2
  echo "$stale_extra_budget_entries" >&2
  exit 1
fi

if [[ -n "$stale_allowed_missing" ]]; then
  echo "Stale allowed missing files; remove these from is_allowed_missing:" >&2
  echo "$stale_allowed_missing" >&2
  exit 1
fi

if [[ -n "$stale_allowed_diff" ]]; then
  echo "Stale allowed diff files; restore HappyClaw or remove these from is_allowed_diff:" >&2
  echo "$stale_allowed_diff" >&2
  exit 1
fi

if [[ -n "$unexpected_allowed_diff_budget" ]]; then
  echo "Allowed diff content changed; restore HappyClaw or update $diff_budget_file after review:" >&2
  echo "$unexpected_allowed_diff_budget" >&2
  exit 1
fi

if [[ -n "$stale_diff_budget_entries" ]]; then
  echo "Stale HappyClaw diff budget entries; remove these from $diff_budget_file:" >&2
  echo "$stale_diff_budget_entries" >&2
  exit 1
fi

if [[ -n "$unexpected_extra" ]]; then
  echo "Unexpected files not present in HappyClaw baseline:" >&2
  echo "$unexpected_extra" >&2
  exit 1
fi

if [[ -n "$unexpected_missing" ]]; then
  echo "Unexpected missing files from HappyClaw baseline:" >&2
  echo "$unexpected_missing" >&2
  exit 1
fi

while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if is_allowed_diff "$path"; then
    continue
  fi
  if [[ -f "$path" && -f "$ref/$path" ]]; then
    if ! cmp -s "$path" "$ref/$path"; then
      echo "Unexpected content drift from HappyClaw baseline: $path" >&2
      exit 1
    fi
  fi
done < <(comm -12 "$current_files" "$ref_files")

echo "HappyClaw baseline file-list check passed."
node "$PWD/scripts/check-happyclaw-routes.mjs"
