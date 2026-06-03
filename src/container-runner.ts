/**
 * Container Runner for happyclaw
 * Spawns agent execution in Docker container and handles IPC
 */
import {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  spawn,
} from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { resolveHostNodeBinary } from './node-resolver.js';
import {
  loadMountAllowlist,
  validateAdditionalMounts,
} from './mount-security.js';
import {
  getContainerEnvConfig,
  getSystemSettings,
  shellQuoteEnvLines,
} from './runtime-config.js';
import {
  getUserRuntimeRoot,
  loadUserPlugins,
  CONTAINER_PLUGINS_PATH,
  type SdkPluginConfig,
} from './plugin-utils.js';
import { materializeUserRuntime } from './plugin-materializer.js';
import { invalidateUserCommandIndex } from './plugin-command-index.js';
import {
  checkHostCapabilities,
  logCapabilityPreflight,
} from './agent-capabilities.js';
import {
  buildRuntimeContextPlan,
  syncHostRuntimeContext,
} from './runtime-context-resolver.js';
import { syncCodexMcpConfig } from './codex-mcp-config.js';
import {
  getCodexRuntimeSettings,
  materializeCodexRuntimeCredentialsToHome,
} from './codex-runtime.js';
import { loadUserMcpServers } from './mcp-utils.js';
import { MessageSourceKind, RegisteredGroup, StreamEvent } from './types.js';
import type { RuntimeContextAudit } from './stream-event.types.js';
import {
  attachStderrHandler,
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  handleSuccessClose,
  handleTimeoutClose,
  writeRunLog,
  type CloseHandlerContext,
} from './agent-output-parser.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  /** Source JID of the latest message that triggered this run (e.g. `discord:123…`).
   * Used by per-channel MCP tools (discord_*, etc.) to identify the current
   * incoming chat. Undefined when chatJid already encodes the IM source. */
  currentSourceJid?: string;
  /** @deprecated Use isHome + isAdminHome instead */
  isMain: boolean;
  turnId?: string;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Isolated task run ID — determines IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** Task ID associated with the latest unprocessed message, when applicable. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  /**
   * Runtime plugin/resource roots populated just-in-time by
   * runContainerAgent/runHostAgent from the owner's plugins.json; never set by
   * the caller.
   */
  plugins?: Array<{ type: 'local'; path: string }>;
  /** Runtime context audit bootstrap passed through to agent-runner. */
  contextAudit?: RuntimeContextAudit;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  finalizationReason?: 'completed' | 'interrupted' | 'error';
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Create directory with 0o777 permissions for container volume mounts.
 * Fixes uid mismatch between host user and container node user (uid 1000),
 * especially in rootless podman where uid remapping causes permission denied.
 */
function mkdirForContainer(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    fs.chmodSync(dirPath, 0o777);
  } catch {
    // Ignore — may fail on read-only filesystem or special mounts
  }
}

/**
 * Best-effort pre-spawn materialize for host-mode plugins. Mirrors the docker
 * path's behaviour in `buildVolumeMounts`: v2 config can exist before the
 * runtime/ tree is built (first enable, or after orphan GC), and
 * `loadUserPlugins({runtime:'host'})` only emits paths whose manifests exist
 * on disk. Without this call host agents would silently start with 0 plugins
 * even when the user has plugins enabled. Failure is logged, never thrown —
 * the agent simply starts with whatever subset is already materialized.
 */
export function prepareHostPlugins(
  ownerId: string | null | undefined,
): SdkPluginConfig[] {
  if (!ownerId) return [];
  try {
    materializeUserRuntime(ownerId);
  } catch (err) {
    logger.warn(
      { ownerId, err },
      'prepareHostPlugins: materializeUserRuntime failed; host agent will see no plugins',
    );
  }
  // Drop the user's command index cache so a stale empty entry (e.g. a prior
  // /commands hit before runtime existed, see plugin-command-index.ts:235) is
  // rebuilt against the now-materialized tree. Invalidate on both success and
  // failure paths: a partial materialize still wants the cache rebuilt.
  invalidateUserCommandIndex(ownerId);
  return loadUserPlugins(ownerId, { runtime: 'host' });
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isAdminHome: boolean,
  mountUserSkills = true,
  agentId?: string,
  ownerHomeFolder?: string,
  taskRunId?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const workspaceRoot = group.customCwd || path.join(GROUPS_DIR, group.folder);

  // Per-user global memory directory:
  // Each user gets their own user-global/{userId}/ mounted as /workspace/global
  const ownerId = group.created_by;
  if (ownerId) {
    const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
    mkdirForContainer(userGlobalDir);
    mounts.push({
      hostPath: userGlobalDir,
      containerPath: '/workspace/global',
      readonly: !group.is_home,
    });
  } else {
    // Legacy fallback for rows without created_by.
    const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
    mkdirForContainer(legacyGlobalDir);
    mounts.push({
      hostPath: legacyGlobalDir,
      containerPath: '/workspace/global',
      readonly: !isAdminHome,
    });
  }

  if (isAdminHome) {
    // Admin home gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Admin home also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Member home and non-home groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Memory directory: home containers write their own; non-home containers read owner's home memory
  const memoryFolder = group.is_home
    ? group.folder
    : ownerHomeFolder || group.folder;
  const memoryDir = path.join(DATA_DIR, 'memory', memoryFolder);
  mkdirForContainer(memoryDir);
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/memory',
    readonly: !group.is_home,
  });

  // Per-group Agent sessions directory (isolated from other groups)
  // Sub-agents get their own session dir under agents/{agentId}/.claude/
  const groupSessionsDir = agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  mkdirForContainer(groupSessionsDir);
  const runtimeContextPlan = buildRuntimeContextPlan({
    executionMode: 'container',
    group,
    ownerHomeFolder,
    projectRoot,
    dataDir: DATA_DIR,
    groupSessionsDir,
    workspaceRoot,
    containerWorkspaceRoot: '/workspace/group',
    mountUserSkills,
  });
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  const groupCodexHome = agentId
    ? path.join(DATA_DIR, 'sessions', group.folder, 'agents', agentId, '.codex')
    : path.join(DATA_DIR, 'sessions', group.folder, '.codex');
  mkdirForContainer(groupCodexHome);
  const materializedCodexCredentials =
    materializeCodexRuntimeCredentialsToHome(groupCodexHome);
  if (
    materializedCodexCredentials.authCopied ||
    materializedCodexCredentials.configCopied
  ) {
    logger.info(
      {
        group: group.name,
        groupFolder: group.folder,
        authCopied: materializedCodexCredentials.authCopied,
        configCopied: materializedCodexCredentials.configCopied,
      },
      'Materialized Codex runtime credentials for workspace',
    );
  }
  syncCodexMcpConfig({
    codexHome: groupCodexHome,
    userMcpServers: ownerId ? loadUserMcpServers(ownerId) : {},
    workspaceRoot,
  });
  mounts.push({
    hostPath: groupCodexHome,
    containerPath: '/home/node/.codex',
    readonly: false,
  });

  // 清理旧运行时遗留的 .claude.json 文件或 symlink，避免继承宿主 Claude 状态。
  const sessionClaudeJson = path.join(groupSessionsDir, '.claude.json');
  try {
    fs.rmSync(sessionClaudeJson, { force: true });
  } catch (err) {
    logger.warn(
      { err, sessionClaudeJson },
      'Failed to remove legacy .claude.json',
    );
  }

  // Skills：以只读卷挂载宿主机目录（由 entrypoint 创建符号链接）
  // 用户的所有 skills 在其所有工作区中全量生效
  const projectSkillsDir = runtimeContextPlan.projectSkillsDir;
  const userSkillsDir = runtimeContextPlan.userSkillsDir ?? null;

  // Ensure user skills directory exists so it can always be mounted.
  // Skills may be installed after the group is created; without pre-creating,
  // the existsSync check would skip mounting and the container would never see them.
  if (userSkillsDir) {
    fs.mkdirSync(userSkillsDir, { recursive: true });
  }

  // 全量挂载：用户的所有 skills 在所有工作区中生效
  if (fs.existsSync(projectSkillsDir)) {
    mounts.push({
      hostPath: projectSkillsDir,
      containerPath: '/workspace/project-skills',
      readonly: true,
    });
  }
  if (userSkillsDir) {
    mounts.push({
      hostPath: userSkillsDir,
      containerPath: '/workspace/user-skills',
      readonly: true,
    });
  }

  // Per-user feishu-cli OAuth state (token.json + config.yaml).
  // Without this mount, every container restart loses the user's feishu OAuth
  // authorization, forcing re-auth every IDLE_TIMEOUT (#477).
  if (ownerId) {
    const userFeishuCliDir = path.join(
      DATA_DIR,
      'config',
      'user-cli',
      ownerId,
      'feishu-cli',
    );
    mkdirForContainer(userFeishuCliDir);
    mounts.push({
      hostPath: userFeishuCliDir,
      containerPath: '/home/node/.feishu-cli',
      readonly: false,
    });
  }

  // Plugin/resource roots (per-user runtime): read-only mount so the runtime
  // inside the container can access directories referenced by ContainerInput.plugins.
  //
  // Admin home runs in `host` mode and bypasses container mounts entirely,
  // so plugin materialization for that path happens inside runHostAgent's
  // host-runtime loadUserPlugins. Here we only handle docker-mode containers.
  //
  // Materialize is synchronous so the runtime tree is on disk before the mount
  // source is picked — loadUserPlugins(docker) returns paths shaped like
  // /workspace/plugins/snapshots/{snap}/{mp}/{plugin}, which only resolve when
  // runtime/{userId}/ is mounted at /workspace/plugins. The runtime root is
  // mkdir'd unconditionally so the bind mount target exists even for users
  // with no enabled plugins yet (an empty mount surfaces nothing to the CLI,
  // matching their config).
  if (ownerId) {
    const runtimeRoot = getUserRuntimeRoot(ownerId);
    fs.mkdirSync(runtimeRoot, { recursive: true });
    try {
      materializeUserRuntime(ownerId);
    } catch (err) {
      logger.warn(
        { ownerId, err },
        'buildVolumeMounts: materializeUserRuntime failed; container will see no plugins',
      );
    }
    // Mirror prepareHostPlugins: drop a stale empty command index that may
    // have been cached before this runtime tree existed (plugin-command-index.ts:235).
    invalidateUserCommandIndex(ownerId);
    mounts.push({
      hostPath: runtimeRoot,
      containerPath: CONTAINER_PLUGINS_PATH,
      readonly: true,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // Sub-agents get their own IPC subdirectory under agents/{agentId}/
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  // Use 0o777 so container (node/1000) and host (agent/1002) can both read/write.
  const groupIpcDir = agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', agentId)
    : taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  mkdirForContainer(groupIpcDir);
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  // Use chmod 777 so both host (agent/1002) and container (node/1000) can write
  for (const sub of ['messages', 'tasks', 'input', 'agents'] as const) {
    const subDir = path.join(groupIpcDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    try {
      fs.chmodSync(subDir, 0o777);
    } catch {
      /* ignore if already correct */
    }
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-container environment file. Codex credentials/config live in the
  // service-managed CODEX_HOME mount, so this only carries explicit workspace
  // custom env and non-secret runtime tuning.
  const envDir = path.join(DATA_DIR, 'env', group.folder);
  fs.mkdirSync(envDir, { recursive: true });
  const containerOverride = getContainerEnvConfig(group.folder);
  const envLines = Object.entries(containerOverride.customEnv || {})
    .filter(([key]) => {
      const normalized = key.trim().toUpperCase();
      return (
        normalized &&
        !normalized.startsWith('ANTHROPIC_') &&
        normalized !== 'CLAUDE_CODE_OAUTH_TOKEN' &&
        normalized !== 'CLAUDE_CONFIG_DIR' &&
        normalized !== 'CODEX_HOME' &&
        normalized !== 'OPENAI_API_KEY' &&
        normalized !== 'CODEX_API_KEY' &&
        normalized !== 'CODEX_ACCESS_TOKEN' &&
        normalized !== 'CODEX_MODEL' &&
        normalized !== 'CODEX_MODEL_REASONING_EFFORT' &&
        normalized !== 'CODEX_REASONING_EFFORT'
      );
    })
    .map(([key, value]) => `${key.trim()}=${value}`);
  if (envLines.length > 0) {
    const envFilePath = path.join(envDir, 'env');
    const quotedLines = shellQuoteEnvLines(envLines);
    fs.writeFileSync(envFilePath, quotedLines.join('\n') + '\n', {
      mode: 0o600,
    });
    try {
      fs.chmodSync(envFilePath, 0o600);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to enforce env file permissions',
      );
    }
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  }

  // Mount agent-runner source from host — recompiled on container startup.
  // Bypasses Docker 镜像构建缓存，确保代码变更生效。
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Per-group persistent extra directory: provides a durable /workspace/extra/ even when
  // no additionalMounts are configured. User-configured additionalMounts from the allowlist
  // are mounted as subdirectories (/workspace/extra/{name}) and overlay on top.
  const extraDir = path.join(DATA_DIR, 'extra', group.folder);
  mkdirForContainer(extraDir);
  mounts.push({
    hostPath: extraDir,
    containerPath: '/workspace/extra',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isAdminHome,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  tz: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  const codexSettings = getCodexRuntimeSettings();

  // Set timezone so container Node.js processes use local time (Asia/Shanghai)
  args.push('-e', `TZ=${tz}`);
  args.push('-e', 'HAPPYCODEX_AGENT_RUNTIME=codex');
  args.push('-e', 'CODEX_HOME=/home/node/.codex');
  args.push('-e', `CODEX_MODEL=${codexSettings.model}`);
  args.push(
    '-e',
    `CODEX_MODEL_REASONING_EFFORT=${codexSettings.reasoningEffort}`,
  );

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);

  // Determine if this is an admin home container (full privileges)
  const isAdminHome = !!group.is_home && group.folder === 'main';
  // Per-user skills: always mount if the group has an owner
  const shouldMountUserSkills = !!group.created_by;
  const mounts = buildVolumeMounts(
    group,
    isAdminHome,
    shouldMountUserSkills,
    input.agentId,
    ownerHomeFolder,
    input.taskRunId,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentSuffix = input.agentId
    ? `-${input.agentId.replace(/[^a-zA-Z0-9-]/g, '-')}`
    : '';
  const containerName = `happycodex-${safeName}${agentSuffix}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, TIMEZONE);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const result = await new Promise<ContainerOutput>((resolve) => {
    const container = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    const stdoutState = createStdoutParserState();
    const stderrState = createStderrState();

    // Write input and close stdin (容器需要 EOF 来刷新 stdin 管道)
    container.stdin.on('error', (err) => {
      logger.error({ group: group.name, err }, 'Container stdin write failed');
      container.kill();
    });
    // Derive a new input with docker-runtime plugins injected; never mutate
    // the caller's `input` object (queue/log/retry paths reuse the same ref).
    const dockerInput: ContainerInput = {
      ...input,
      plugins: group.created_by
        ? loadUserPlugins(group.created_by, { runtime: 'docker' })
        : [],
      contextAudit: buildRuntimeContextPlan({
        executionMode: 'container',
        group,
        ownerHomeFolder,
        projectRoot: process.cwd(),
        dataDir: DATA_DIR,
        groupSessionsDir: input.agentId
          ? path.join(
              DATA_DIR,
              'sessions',
              group.folder,
              'agents',
              input.agentId,
              '.claude',
            )
          : path.join(DATA_DIR, 'sessions', group.folder, '.claude'),
        workspaceRoot: group.customCwd || path.join(GROUPS_DIR, group.folder),
        containerWorkspaceRoot: '/workspace/group',
        mountUserSkills: shouldMountUserSkills,
      }).audit,
    };
    container.stdin.write(JSON.stringify(dockerInput));
    container.stdin.end();

    let timedOut = false;
    const timeoutMs =
      group.containerConfig?.timeout || getSystemSettings().containerTimeout;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      execFile('docker', ['stop', containerName], { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };
    const handleOutput = onOutput
      ? async (output: ContainerOutput): Promise<void> => {
          await onOutput(output);
        }
      : undefined;

    // Attach stdout/stderr handlers using shared parser
    attachStdoutHandler(container.stdout, stdoutState, {
      groupName: group.name,
      label: 'Container',
      onOutput: handleOutput,
      resetTimeout,
    });
    attachStderrHandler(container.stderr, stderrState, group.name, {
      container: group.folder,
    });

    container.on('close', (code, signal) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      const closeCtx: CloseHandlerContext = {
        groupName: group.name,
        label: 'Container',
        filePrefix: 'container',
        identifier: containerName,
        logsDir,
        input,
        stdoutState,
        stderrState,
        onOutput,
        resolvePromise: resolve,
        startTime,
        timeoutMs,
        extraSummaryLines: [
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
        ],
        extraVerboseLines: [
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts (detailed) ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
        ],
      };

      if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
      const logFile = writeRunLog(closeCtx, code, duration);
      if (handleNonZeroExit(closeCtx, code, signal, duration, logFile)) return;
      handleSuccessClose(closeCtx, duration);
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });

  return result;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all tasks, others only see their own
  const filteredTasks = isAdminHome
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  // 删除后重建：容器创建的文件归属 node(1000) 用户，宿主机进程无法覆写
  try {
    fs.unlinkSync(tasksFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only admin home can see all available groups (for activation).
 * Other groups see nothing (they can't activate groups).
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isAdminHome ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  try {
    fs.unlinkSync(groupsFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * 杀死进程及其所有子进程。
 * 如果进程以 detached 模式启动（独立进程组），使用负 PID 杀整个进程组。
 */
export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
      return true;
    }
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Run agent directly on the host machine (no Docker container).
 * Used for host execution mode — the agent gets full access to the host filesystem.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, identifier: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const setupInstallHint = 'npm --prefix container/agent-runner install';
  const setupBuildHint = 'npm --prefix container/agent-runner run build';
  const hostModeSetupError = (message: string): ContainerOutput => ({
    status: 'error',
    result: `宿主机模式启动失败：${message}`,
    error: message,
  });

  // 1. 确定工作目录
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  if (!group.customCwd) {
    fs.mkdirSync(defaultGroupDir, { recursive: true });
    // 确保 group 目录是独立 git root，防止运行时向上找到父项目的 .git
    const gitDir = path.join(defaultGroupDir, '.git');
    if (!fs.existsSync(gitDir)) {
      try {
        execFileSync('git', ['init'], {
          cwd: defaultGroupDir,
          stdio: 'ignore',
        });
        logger.info(
          { folder: group.folder },
          'Initialized git repository for group',
        );
      } catch (err) {
        // Non-fatal: agent still works, just reports wrong working directory
        logger.warn(
          { folder: group.folder, err },
          'Failed to initialize git repository',
        );
      }
    }
  }
  let groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return hostModeSetupError(`工作目录必须是绝对路径：${groupDir}`);
  }
  // Resolve symlinks to prevent TOCTOU attacks
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return hostModeSetupError(`工作目录不存在或无法解析：${groupDir}`);
  }
  if (!fs.statSync(groupDir).isDirectory()) {
    return hostModeSetupError(`工作目录不是目录：${groupDir}`);
  }

  // Runtime allowlist validation for custom CWD (defense-in-depth: web.ts validates at creation,
  // but re-check here in case allowlist was tightened or path was injected via DB)
  if (group.customCwd) {
    const allowlist = loadMountAllowlist();
    if (
      allowlist &&
      allowlist.allowedRoots &&
      allowlist.allowedRoots.length > 0
    ) {
      let allowed = false;
      for (const root of allowlist.allowedRoots) {
        const expandedRoot = root.path.startsWith('~')
          ? path.join(
              process.env.HOME || '/home/user',
              root.path.slice(root.path.startsWith('~/') ? 2 : 1),
            )
          : path.resolve(root.path);

        let realRoot: string;
        try {
          realRoot = fs.realpathSync(expandedRoot);
        } catch {
          continue;
        }

        const relative = path.relative(realRoot, groupDir);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return hostModeSetupError(
          `工作目录 ${groupDir} 不在允许的根目录下，请检查 mount-allowlist.json`,
        );
      }
    }
  }

  // Always store logs in data/groups/{folder}/logs/, not in customCwd
  const logsBaseDir = path.join(defaultGroupDir, 'logs');
  fs.mkdirSync(logsBaseDir, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'memory', group.folder), {
    recursive: true,
  });

  // 2. 确保目录结构（宿主机模式下限制目录权限）
  // Sub-agents get their own IPC and session directories
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
    : input.taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', input.taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), {
    recursive: true,
    mode: 0o700,
  });
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  fs.mkdirSync(path.join(groupIpcDir, 'agents'), {
    recursive: true,
    mode: 0o700,
  });

  const groupSessionsDir = input.agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        input.agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const groupCodexHome = input.agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        input.agentId,
        '.codex',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.codex');
  fs.mkdirSync(groupCodexHome, { recursive: true });
  const materializedCodexCredentials =
    materializeCodexRuntimeCredentialsToHome(groupCodexHome);
  if (
    materializedCodexCredentials.authCopied ||
    materializedCodexCredentials.configCopied
  ) {
    logger.info(
      {
        group: group.name,
        groupFolder: group.folder,
        authCopied: materializedCodexCredentials.authCopied,
        configCopied: materializedCodexCredentials.configCopied,
      },
      'Materialized Codex runtime credentials for workspace',
    );
  }
  syncCodexMcpConfig({
    codexHome: groupCodexHome,
    userMcpServers: group.created_by
      ? loadUserMcpServers(group.created_by)
      : {},
    workspaceRoot: groupDir,
  });

  // 清理旧运行时遗留的 .claude.json 文件或 symlink，避免继承宿主 Claude 状态。
  try {
    fs.rmSync(path.join(groupSessionsDir, '.claude.json'), { force: true });
  } catch (err) {
    logger.warn(
      { err, groupSessionsDir },
      'Failed to remove legacy .claude.json',
    );
  }

  // 3. Runtime context sync: product/user skills only; external CLAUDE.md/rules stay disabled.
  const hostRuntimeContextPlan = buildRuntimeContextPlan({
    executionMode: 'host',
    group,
    ownerHomeFolder,
    projectRoot: process.cwd(),
    dataDir: DATA_DIR,
    groupSessionsDir,
    workspaceRoot: groupDir,
  });
  const hostRuntimeContextSync = syncHostRuntimeContext(
    hostRuntimeContextPlan,
    groupSessionsDir,
  );
  hostRuntimeContextPlan.audit.instructions.status =
    hostRuntimeContextSync.instructionsStatus;
  hostRuntimeContextPlan.audit.warnings = hostRuntimeContextSync.warnings;

  // 5. 构建环境变量
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
  ]) {
    delete hostEnv[key];
  }
  const codexSettings = getCodexRuntimeSettings();
  hostEnv['HAPPYCODEX_AGENT_RUNTIME'] = 'codex';
  hostEnv['CODEX_HOME'] = groupCodexHome;
  hostEnv['CODEX_MODEL'] = codexSettings.model;
  hostEnv['CODEX_MODEL_REASONING_EFFORT'] = codexSettings.reasoningEffort;

  try {
    const containerOverride = getContainerEnvConfig(group.folder);
    for (const [key, value] of Object.entries(
      containerOverride.customEnv || {},
    )) {
      const normalized = key.trim().toUpperCase();
      if (
        !normalized ||
        normalized.startsWith('ANTHROPIC_') ||
        normalized === 'CLAUDE_CODE_OAUTH_TOKEN' ||
        normalized === 'CLAUDE_CONFIG_DIR' ||
        normalized === 'CODEX_HOME' ||
        normalized === 'OPENAI_API_KEY' ||
        normalized === 'CODEX_API_KEY' ||
        normalized === 'CODEX_ACCESS_TOKEN' ||
        normalized === 'CODEX_MODEL' ||
        normalized === 'CODEX_MODEL_REASONING_EFFORT' ||
        normalized === 'CODEX_REASONING_EFFORT'
      ) {
        continue;
      }
      hostEnv[key.trim()] = value;
    }

    // 路径映射
    hostEnv['HAPPYCLAW_WORKSPACE_GROUP'] = groupDir;
    hostEnv['HAPPYCLAW_WORKSPACE_IPC'] = groupIpcDir;

    // Per-user global memory（HappyClaw 自带 memory 层）
    const ownerId = group.created_by;
    if (ownerId) {
      const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
      fs.mkdirSync(userGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = userGlobalDir;
    } else {
      const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
      fs.mkdirSync(legacyGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = legacyGlobalDir;
    }
    const memoryFolder = group.is_home
      ? group.folder
      : ownerHomeFolder || group.folder;
    hostEnv['HAPPYCLAW_WORKSPACE_MEMORY'] = path.join(
      DATA_DIR,
      'memory',
      memoryFolder,
    );

    // 5b. Host capability preflight — detect external tools & inject env vars
    const capResult = await checkHostCapabilities();
    logCapabilityPreflight(group.name, capResult);
    for (const [key, value] of Object.entries(capResult.envVars)) {
      if (!hostEnv[key]) hostEnv[key] = value;
    }

    // Prepend the resolved Codex binary directory to PATH so agent-runner
    // subprocesses hit the checked CLI first.
    if (capResult.resolvedPaths['codex']) {
      const resolvedCodexDir = path.dirname(capResult.resolvedPaths['codex']);
      const currentPath = hostEnv['PATH'] || process.env.PATH || '';
      hostEnv['PATH'] = `${resolvedCodexDir}:${currentPath}`;
      logger.info(
        {
          group: group.name,
          resolvedCodexDir,
          resolvedPath: capResult.resolvedPaths['codex'],
        },
        'Host preflight: codex binary resolved',
      );
    }

    // 6. 编译检查
    const projectRoot = process.cwd();
    const agentRunnerRoot = path.join(projectRoot, 'container', 'agent-runner');
    const agentRunnerDist = path.join(agentRunnerRoot, 'dist', 'index.js');
    if (!fs.existsSync(agentRunnerDist)) {
      logger.error(
        { group: group.name, agentRunnerDist },
        'Host agent preflight failed: dist not found',
      );
      return hostModeSetupError(
        `agent-runner 未编译。请先执行：${setupBuildHint}`,
      );
    }

    // Auto-rebuild if dist is stale (src newer than dist)
    try {
      const distMtime = fs.statSync(agentRunnerDist).mtimeMs;
      const srcDir = path.join(agentRunnerRoot, 'src');
      const srcFiles = fs.readdirSync(srcDir);
      const newestSrc = Math.max(
        ...srcFiles.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs),
      );
      if (newestSrc > distMtime) {
        logger.info(
          { group: group.name },
          'agent-runner dist 已过期，自动重新编译...',
        );
        try {
          const { execSync } = await import('child_process');
          execSync('npm run build', {
            cwd: agentRunnerRoot,
            stdio: 'pipe',
            timeout: 30_000,
          });
          logger.info({ group: group.name }, 'agent-runner 自动编译完成');
        } catch (buildErr) {
          logger.warn(
            { group: group.name, err: buildErr },
            `agent-runner 自动编译失败，使用旧版 dist。手动执行：${setupBuildHint}`,
          );
        }
      }
    } catch {
      // Best effort, don't block execution
    }

    logger.info(
      {
        group: group.name,
        workingDir: groupDir,
        isMain: input.isMain,
      },
      'Spawning host agent',
    );

    const logsDir = logsBaseDir;

    const hostResult = await new Promise<ContainerOutput>((resolve) => {
      let settled = false;
      const resolveOnce = (output: ContainerOutput): void => {
        if (settled) return;
        settled = true;
        resolve(output);
      };

      // 7. 启动进程
      // Resolve absolute node path: bare 'node' fails with ENOENT under
      // PM2 / launchd / GUI launchers where PATH lacks nvm/fnm dirs.
      const hostNodeBinary = resolveHostNodeBinary(hostEnv);
      const proc = spawn(hostNodeBinary, [agentRunnerDist], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: hostEnv,
        cwd: groupDir,
        detached: true,
      });

      const processId = `host-${group.folder}-${Date.now()}`;
      onProcess(proc, processId);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // 8. stdin 输入
      proc.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Host agent stdin write failed',
        );
        killProcessTree(proc);
      });
      // Derive a new input with host-runtime plugins injected; never mutate
      // the caller's `input` object (queue/log/retry paths reuse the same ref).
      // prepareHostPlugins mirrors the docker path's pre-spawn materialize so
      // a freshly-enabled v2 user (no runtime/ on disk yet) doesn't see 0
      // plugins.
      const hostInput: ContainerInput = {
        ...input,
        plugins: prepareHostPlugins(group.created_by),
        contextAudit: hostRuntimeContextPlan.audit,
      };
      proc.stdin.write(JSON.stringify(hostInput));
      proc.stdin.end();

      // 9. 超时管理
      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, processId },
          'Host agent timeout, killing',
        );
        killProcessTree(proc, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            killProcessTree(proc, 'SIGKILL');
          }
        }, 5000);
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };
      const handleOutput = onOutput
        ? async (output: ContainerOutput): Promise<void> => {
            await onOutput(output);
          }
        : undefined;

      // 10. stdout/stderr 解析
      attachStdoutHandler(proc.stdout, stdoutState, {
        groupName: group.name,
        label: 'Host agent',
        onOutput: handleOutput,
        resetTimeout,
      });
      attachStderrHandler(proc.stderr, stderrState, group.name, {
        host: group.folder,
      });

      // 11. close 事件处理
      proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Host Agent',
          filePrefix: 'host',
          identifier: processId,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput,
          resolvePromise: resolveOnce,
          startTime,
          timeoutMs,
          extraSummaryLines: [`Working Directory: ${groupDir}`],
          enrichError: (stderrContent, exitLabel) => {
            const missingPackageMatch = stderrContent.match(
              /Cannot find package '([^']+)' imported from/u,
            );
            const userFacingError = missingPackageMatch
              ? `宿主机模式启动失败：缺少依赖 ${missingPackageMatch[1]}。请先执行：${setupInstallHint}`
              : null;
            return {
              result: userFacingError,
              error: `Host agent exited with ${exitLabel}: ${stderrContent.slice(-200)}`,
            };
          },
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, processId, error: err },
          'Host agent spawn error',
        );
        resolveOnce({
          status: 'error',
          result: null,
          error: `Host agent spawn error: ${err.message}`,
        });
      });
    });

    return hostResult;
  } finally {
  }
}
