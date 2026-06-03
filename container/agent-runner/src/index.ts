/**
 * HappyCodex Agent Runner
 * Runs inside a container or host process, receives config via stdin, outputs
 * result to stdout.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectImageMimeTypeFromBase64Strict } from './image-detector.js';
import { getChannelFromJid } from './channel-prefixes.js';

import type {
  ContainerInput,
  ContainerOutput,
  ImageMediaType,
} from './types.js';
import type { RuntimeContextAudit } from './stream-event.types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import {
  isCodexContextOverflowError,
  isCodexResumeSessionMissingError,
  runCodexExec,
  type CodexJsonEvent,
} from './codex-cli.js';
import { buildCodexPromptForSession } from './codex-prompt.js';
import {
  buildCodexRuntimeContextAudit,
  shouldEmitCodexContextAudit,
} from './codex-runtime-adapter.js';
import { syncCodexRuntimeGuidance } from './codex-runtime-guidance.js';
import { buildRuntimeSkillsPrompt } from './runtime-skills.js';

// 路径解析：优先读取环境变量，降级到容器内默认路径（保持向后兼容）
const WORKSPACE_GROUP =
  process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';

const CODEX_MODEL = process.env.CODEX_MODEL?.trim() || 'gpt-5.5';
const CODEX_REASONING_EFFORT =
  process.env.CODEX_MODEL_REASONING_EFFORT?.trim() ||
  process.env.CODEX_REASONING_EFFORT?.trim() ||
  'xhigh';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_FALLBACK_POLL_MS = 5000; // 后备轮询间隔（仅防止 inotify 事件丢失）

// Module-level session ID so SIGTERM handler can emit it before exit.
// Updated in main() whenever a query returns a new session.
let latestSessionId: string | undefined;

const IMAGE_MAX_DIMENSION = 8000; // Conservative runtime image dimension guard

// ── 系统提示词从独立 Markdown 文件加载（启动期一次性 readFileSync 缓存到模块级常量）──
// 文件位于 container/agent-runner/prompts/，便于改提示词无需重编译 + CR 友好。

const PROMPTS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'prompts',
);

function loadPrompt(...segments: string[]): string {
  return fs
    .readFileSync(path.join(PROMPTS_DIR, ...segments), 'utf-8')
    .trimEnd();
}

const SECURITY_RULES = loadPrompt('security-rules.md');
const INTERACTION_GUIDELINES = loadPrompt('interaction.md');
const SKILL_ROUTING_GUIDELINES = loadPrompt('skill-routing.md');
const OUTPUT_GUIDELINES = loadPrompt('output.md');
const WEB_FETCH_GUIDELINES = loadPrompt('web-fetch.md');
const BACKGROUND_TASK_GUIDELINES = loadPrompt('background-tasks.md');
const CONVERSATION_AGENT_GUIDELINES = loadPrompt('agent-override.md');
const MEMORY_SYSTEM_HOME = loadPrompt('memory-system.home.md');
const MEMORY_SYSTEM_GUEST = loadPrompt('memory-system.guest.md');

const GUIDELINES_BLOCK = `<guidelines>\n${OUTPUT_GUIDELINES}\n${WEB_FETCH_GUIDELINES}\n${BACKGROUND_TASK_GUIDELINES}\n</guidelines>`;
const CONVERSATION_AGENT_BLOCK = `<agent-override>\n${CONVERSATION_AGENT_GUIDELINES}\n</agent-override>`;

interface PromptPiece {
  name: string;
  text: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

function buildPromptAudit(
  pieces: PromptPiece[],
): RuntimeContextAudit['runtimePrompt'] {
  const files = pieces.map((piece) => ({
    name: piece.name,
    bytes: byteLength(piece.text),
  }));
  return {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function buildSecurityRulesPrompt(): string {
  return SECURITY_RULES;
}

function runtimeContextAuditBase(
  containerInput: ContainerInput,
): RuntimeContextAudit {
  return {
    executionMode: containerInput.contextAudit?.executionMode ?? 'container',
    cwd: WORKSPACE_GROUP,
    instructions: containerInput.contextAudit?.instructions ?? {
      status: 'unknown',
    },
    rules: containerInput.contextAudit?.rules ?? {
      status: 'unknown',
      fileCount: 0,
    },
    skills: containerInput.contextAudit?.skills ?? { sources: [] },
    runtimePrompt: containerInput.contextAudit?.runtimePrompt ?? {
      totalBytes: 0,
      files: [],
    },
    warnings: [...(containerInput.contextAudit?.warnings ?? [])],
  };
}

// 启动期扫描 prompts/channels/*.md，文件名（去 .md 后缀）= channel key（feishu / telegram / qq / dingtalk / ...）
// 新增渠道时只需在 channels/ 下加一个 .md 文件，无需改代码。
const CHANNEL_GUIDELINES: Record<string, string> = (() => {
  const channelsDir = path.join(PROMPTS_DIR, 'channels');
  const result: Record<string, string> = {};
  if (!fs.existsSync(channelsDir)) return result;
  for (const file of fs.readdirSync(channelsDir)) {
    if (!file.endsWith('.md')) continue;
    const channelKey = file.slice(0, -'.md'.length);
    result[channelKey] = fs
      .readFileSync(path.join(channelsDir, file), 'utf-8')
      .trimEnd();
  }
  return result;
})();

/**
 * 规范化图片 MIME：
 * - 优先使用声明值（若合法且与内容一致）
 * - 若声明缺失或与内容不一致，使用内容识别值
 * - 最后兜底 image/jpeg
 */
function resolveImageMimeType(img: {
  data: string;
  mimeType?: string;
}): ImageMediaType {
  const declared =
    typeof img.mimeType === 'string' && img.mimeType.startsWith('image/')
      ? img.mimeType.toLowerCase()
      : undefined;
  const detected = detectImageMimeTypeFromBase64Strict(img.data);

  if (declared && detected && declared !== detected) {
    log(
      `Image MIME mismatch: declared=${declared}, detected=${detected}, using detected`,
    );
    return detected as ImageMediaType;
  }

  return (declared || detected || 'image/jpeg') as ImageMediaType;
}

/**
 * 从 base64 编码的图片数据中提取宽高（支持 PNG / JPEG / GIF / WebP / BMP）。
 * 仅解析头部字节，不需要完整解码图片。
 * 返回 null 表示无法识别格式。
 */
function getImageDimensions(
  base64Data: string,
): { width: number; height: number } | null {
  try {
    const headerB64 = base64Data.slice(0, 400);
    const buf = Buffer.from(headerB64, 'base64');

    // PNG: 固定位置 (bytes 16-23)
    if (
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // JPEG: 扫描 SOF marker（SOF 可能在大 EXIF/ICC 之后，需要 ~30KB）
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      const JPEG_SCAN_B64_LEN = 40000; // ~30KB binary，覆盖大多数 EXIF/ICC 场景
      const fullHeader = Buffer.from(
        base64Data.slice(0, JPEG_SCAN_B64_LEN),
        'base64',
      );
      for (let i = 2; i < fullHeader.length - 9; i++) {
        if (fullHeader[i] !== 0xff) continue;
        const marker = fullHeader[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            width: fullHeader.readUInt16BE(i + 7),
            height: fullHeader.readUInt16BE(i + 5),
          };
        }
        if (marker !== 0xd8 && marker !== 0xd9 && marker !== 0x00) {
          i += 1 + fullHeader.readUInt16BE(i + 2);
        }
      }
    }

    // GIF: bytes 6-9 (little-endian)
    if (
      buf.length >= 10 &&
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46
    ) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    // BMP: bytes 18-25
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return {
        width: buf.readInt32LE(18),
        height: Math.abs(buf.readInt32LE(22)),
      };
    }

    // WebP
    if (
      buf.length >= 30 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46
    ) {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && buf.length >= 30)
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      if (fourCC === 'VP8L' && buf.length >= 25) {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fourCC === 'VP8X' && buf.length >= 30)
        return {
          width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
          height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
        };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 过滤超过 API 尺寸限制的图片。
 */
function filterOversizedImages(
  images: Array<{ data: string; mimeType?: string }>,
): { valid: Array<{ data: string; mimeType?: string }>; rejected: string[] } {
  const valid: Array<{ data: string; mimeType?: string }> = [];
  const rejected: string[] = [];
  for (const img of images) {
    const dims = getImageDimensions(img.data);
    if (
      dims &&
      (dims.width > IMAGE_MAX_DIMENSION || dims.height > IMAGE_MAX_DIMENSION)
    ) {
      const reason = `图片尺寸 ${dims.width}×${dims.height} 超过 API 限制（最大 ${IMAGE_MAX_DIMENSION}px），已跳过`;
      log(reason);
      rejected.push(reason);
    } else {
      valid.push(img);
    }
  }
  return { valid, rejected };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function generateTurnId(): string {
  return `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize isMain/isHome/isAdminHome flags for backward compatibility.
 * If the host sends the old `isMain` field, treat it as isHome=true + isAdminHome=true.
 */
function normalizeHomeFlags(input: ContainerInput): {
  isHome: boolean;
  isAdminHome: boolean;
} {
  if (input.isHome !== undefined) {
    return { isHome: !!input.isHome, isAdminHome: !!input.isAdminHome };
  }
  // Legacy: isMain was the only flag
  const legacy = !!input.isMain;
  return { isHome: legacy, isAdminHome: legacy };
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

const IPC_INPUT_DRAIN_SENTINEL = path.join(IPC_INPUT_DIR, '_drain');

const IPC_INPUT_INTERRUPT_SENTINEL = path.join(IPC_INPUT_DIR, '_interrupt');
const INTERRUPT_GRACE_WINDOW_MS = 10_000;
let lastInterruptRequestedAt = 0;

function markInterruptRequested(): void {
  lastInterruptRequestedAt = Date.now();
}

function clearInterruptRequested(): void {
  lastInterruptRequestedAt = 0;
}

function isWithinInterruptGraceWindow(): boolean {
  return (
    lastInterruptRequestedAt > 0 &&
    Date.now() - lastInterruptRequestedAt <= INTERRUPT_GRACE_WINDOW_MS
  );
}

function isInterruptRelatedError(err: unknown): boolean {
  const errno = err as NodeJS.ErrnoException;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    errno?.code === 'ABORT_ERR' ||
    /abort|aborted|interrupt|interrupted|cancelled|canceled/i.test(message)
  );
}

/**
 * Check for _interrupt sentinel (graceful query interruption).
 */
function shouldInterrupt(): boolean {
  if (fs.existsSync(IPC_INPUT_INTERRUPT_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
    } catch {
      /* ignore */
    }
    markInterruptRequested();
    return true;
  }
  return false;
}

function cleanupStartupInterruptSentinel(): void {
  try {
    const stat = fs.statSync(IPC_INPUT_INTERRUPT_SENTINEL);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs <= INTERRUPT_GRACE_WINDOW_MS) {
      log(
        `Preserving recent interrupt sentinel at startup (${Math.round(ageMs)}ms old)`,
      );
      return;
    }
    fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
    log(
      `Removed stale interrupt sentinel at startup (${Math.round(ageMs)}ms old)`,
    );
  } catch {
    /* ignore */
  }
}

/**
 * Check for _drain sentinel (finish current query then exit).
 * Unlike _close which exits from idle wait, _drain is checked after
 * a query completes to implement one-question-one-answer semantics.
 */
function shouldDrain(): boolean {
  if (fs.existsSync(IPC_INPUT_DRAIN_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_DRAIN_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found (with optional images), or empty array.
 */
interface IpcDrainResult {
  messages: Array<{
    text: string;
    images?: Array<{ data: string; mimeType?: string }>;
    taskId?: string;
    sourceJid?: string;
  }>;
}

function drainIpcInput(): IpcDrainResult {
  const result: IpcDrainResult = { messages: [] };
  try {
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          result.messages.push({
            text: data.text,
            images: data.images,
            taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
            sourceJid:
              typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
          });
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

/**
 * Create a fs.watch() based IPC watcher for event-driven file detection.
 * Falls back to periodic polling every IPC_FALLBACK_POLL_MS.
 */
function createIpcWatcher(onFileDetected: () => void): { close: () => void } {
  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const debouncedDetect = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onFileDetected();
    }, 50);
  };

  // Ensure IPC_INPUT_DIR exists
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  } catch {}

  try {
    // Listen to all event types — 'rename' covers atomic writes on Linux,
    // but Docker bind mounts (macOS virtiofs) may emit 'change' instead.
    watcher = fs.watch(IPC_INPUT_DIR, () => {
      debouncedDetect();
    });
    watcher.on('error', (err) => {
      log(
        `IPC watcher error: ${err.message}, degrading to ${IPC_FALLBACK_POLL_MS}ms fallback polling`,
      );
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    log(
      `Failed to create IPC watcher: ${err instanceof Error ? err.message : String(err)}, using fallback polling`,
    );
  }

  // Fallback polling for reliability
  fallbackTimer = setInterval(() => {
    if (!closed) onFileDetected();
  }, IPC_FALLBACK_POLL_MS);
  fallbackTimer.unref(); // Don't prevent process from naturally exiting

  return {
    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    },
  };
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages (with optional images), or null if _close.
 */
function waitForIpcMessage(): Promise<{
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  taskId?: string;
  sourceJid?: string;
} | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const tryDrain = () => {
      if (resolved) return;

      if (shouldClose()) {
        resolved = true;
        ipcWatcher?.close();
        resolve(null);
        return;
      }

      if (shouldDrain()) {
        log('Drain sentinel received, exiting after completed query');
        resolved = true;
        ipcWatcher?.close();
        resolve(null);
        return;
      }

      if (shouldInterrupt()) {
        log('Interrupt sentinel received while idle, ignoring');
        clearInterruptRequested();
      }

      const { messages } = drainIpcInput();

      if (messages.length > 0) {
        const combinedText = messages.map((m) => m.text).join('\n');
        const allImages = messages.flatMap((m) => m.images || []);
        // If any drained message carries a taskId, attribute the combined turn
        // to it (take the last one — later messages supersede earlier in a batch).
        let combinedTaskId: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].taskId) {
            combinedTaskId = messages[i].taskId;
            break;
          }
        }
        // Same convention for sourceJid: downstream channel-aware code should see
        // the chat the most recent message arrived from.
        let combinedSourceJid: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].sourceJid) {
            combinedSourceJid = messages[i].sourceJid;
            break;
          }
        }
        resolved = true;
        ipcWatcher?.close();
        resolve({
          text: combinedText,
          images: allImages.length > 0 ? allImages : undefined,
          taskId: combinedTaskId,
          sourceJid: combinedSourceJid,
        });
        return;
      }
    };

    const ipcWatcher = createIpcWatcher(tryDrain);
    // Initial check in case files already exist
    tryDrain();
  });
}

function buildMemoryRecallPrompt(isHome: boolean): string {
  return isHome ? MEMORY_SYSTEM_HOME : MEMORY_SYSTEM_GUEST;
}

interface QueryResultState {
  newSessionId?: string;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
}

function buildRuntimePromptPieces(
  containerInput: ContainerInput,
  memoryRecall: string,
): {
  systemPromptAppend: string;
  promptAudit: RuntimeContextAudit['runtimePrompt'];
  contextAuditBase: RuntimeContextAudit;
  writableRoots: string[];
} {
  const { isHome } = normalizeHomeFlags(containerInput);
  const channel = getChannelFromJid(containerInput.chatJid);
  const channelGuidelines = CHANNEL_GUIDELINES[channel] ?? '';
  const contextAuditBase = runtimeContextAuditBase(containerInput);
  const runtimeSkills = buildRuntimeSkillsPrompt(
    contextAuditBase,
    containerInput.plugins,
  );
  contextAuditBase.skills = {
    ...contextAuditBase.skills,
    includedSkills: runtimeSkills.includedSkills,
    totalSkills: runtimeSkills.totalSkills,
    tokens: runtimeSkills.tokens,
  };
  contextAuditBase.warnings.push(...runtimeSkills.warnings);
  const memoryPromptName = isHome
    ? 'memory-system.home.md'
    : 'memory-system.guest.md';

  const promptPieces: PromptPiece[] = [
    {
      name: 'interaction.md',
      text: `<behavior>\n${INTERACTION_GUIDELINES}\n</behavior>`,
    },
    {
      name: 'skill-routing.md',
      text: `<skill-routing>\n${SKILL_ROUTING_GUIDELINES}\n</skill-routing>`,
    },
    ...(runtimeSkills.prompt
      ? [{ name: 'runtime-skills', text: runtimeSkills.prompt }]
      : []),
    {
      name: 'security-rules.md',
      text: `<security>\n${buildSecurityRulesPrompt()}\n</security>`,
    },
    ...(memoryRecall && memoryPromptName
      ? [
          {
            name: memoryPromptName,
            text: `<memory-system>\n${memoryRecall}\n</memory-system>`,
          },
        ]
      : []),
    { name: 'guidelines', text: GUIDELINES_BLOCK },
    ...(channelGuidelines
      ? [
          {
            name: `channels/${channel}.md`,
            text: `<channel-format>\n${channelGuidelines}\n</channel-format>`,
          },
        ]
      : []),
    ...(containerInput.agentId
      ? [{ name: 'agent-override.md', text: CONVERSATION_AGENT_BLOCK }]
      : []),
  ];

  const systemPromptAppend = promptPieces.map((piece) => piece.text).join('\n');
  return {
    systemPromptAppend,
    promptAudit: buildPromptAudit(promptPieces),
    contextAuditBase,
    writableRoots: runtimeSkills.roots,
  };
}

function getCodexRuntimeHome(): string {
  return (
    process.env.CODEX_HOME ||
    path.join(process.env.HOME || '/home/node', '.codex')
  );
}

function codexEventType(event: CodexJsonEvent): string {
  const rawType = event.type;
  return typeof rawType === 'string' ? rawType : 'unknown';
}

function summarizeCodexEvent(event: CodexJsonEvent): string | undefined {
  const rawType = codexEventType(event);
  if (rawType === 'thread.started' && typeof event.thread_id === 'string') {
    return `thread ${event.thread_id}`;
  }
  if (rawType === 'item.completed') {
    const item = event.item;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const itemType = (item as Record<string, unknown>).type;
      return typeof itemType === 'string' ? itemType : undefined;
    }
  }
  return undefined;
}

async function materializeCodexImages(
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<{ paths: string[]; cleanup: () => void; rejected: string[] }> {
  if (!images || images.length === 0) {
    return { paths: [], cleanup: () => {}, rejected: [] };
  }

  const { valid, rejected } = filterOversizedImages(images);
  if (valid.length === 0) {
    return { paths: [], cleanup: () => {}, rejected };
  }

  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happycodex-codex-images-'),
  );
  const paths: string[] = [];
  for (const [index, image] of valid.entries()) {
    const mime = resolveImageMimeType(image);
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const file = path.join(dir, `image-${index + 1}.${ext}`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    paths.push(file);
  }

  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
    rejected,
  };
}

async function runCodexQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  memoryRecall: string,
  emitOutput: boolean,
  images?: Array<{ data: string; mimeType?: string }>,
  sourceKindOverride?: ContainerOutput['sourceKind'],
): Promise<QueryResultState> {
  let newSessionId = sessionId;
  const emit = (output: ContainerOutput): void => {
    const decorated: ContainerOutput = {
      ...output,
      turnId: containerInput.turnId,
      sessionId: newSessionId,
      ...(output.streamEvent
        ? {
            streamEvent: {
              ...output.streamEvent,
              turnId: containerInput.turnId,
              sessionId: newSessionId,
            },
          }
        : {}),
    };
    if (emitOutput) writeOutput(decorated);
  };

  if (shouldInterrupt()) {
    log('Interrupt sentinel detected before Codex exec start, skipping query');
    clearInterruptRequested();
    return {
      newSessionId,
      closedDuringQuery: false,
      interruptedDuringQuery: true,
    };
  }
  if (shouldClose()) {
    log('Close sentinel detected before Codex exec start');
    return {
      newSessionId,
      closedDuringQuery: true,
      interruptedDuringQuery: false,
    };
  }

  const { systemPromptAppend, promptAudit, contextAuditBase, writableRoots } =
    buildRuntimePromptPieces(containerInput, memoryRecall);
  const contextAudit = buildCodexRuntimeContextAudit(
    contextAuditBase,
    promptAudit,
  );

  if (shouldEmitCodexContextAudit(contextAudit)) {
    emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'context_audit',
        agentScope: 'system',
        displayLevel: 'detail',
        title: 'Agent Context',
        summary: `${contextAudit.rules.fileCount} rules`,
        contextAudit,
      },
    });
  }

  const codexHome = getCodexRuntimeHome();
  const guidanceSync = syncCodexRuntimeGuidance({
    codexHome,
    runtimeGuidance: systemPromptAppend,
  });
  log(
    `Synced Codex runtime guidance to ${guidanceSync.agentsPath} (${guidanceSync.bytes} bytes)`,
  );

  const imageFiles = await materializeCodexImages(images);
  for (const reason of imageFiles.rejected) {
    emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId });
  }

  const codexPrompt = buildCodexPromptForSession({
    prompt,
  });

  try {
    const result = await runCodexExec({
      prompt: codexPrompt,
      cwd: WORKSPACE_GROUP,
      codexHome,
      sessionId,
      model: CODEX_MODEL,
      reasoningEffort: CODEX_REASONING_EFFORT,
      sandbox: 'workspace-write',
      images: imageFiles.paths,
      writableRoots,
      onEvent: (event) => {
        if (event.type === 'thread.started') {
          const threadId =
            typeof event.thread_id === 'string'
              ? event.thread_id
              : typeof event.threadId === 'string'
                ? event.threadId
                : undefined;
          if (threadId) newSessionId = threadId;
        }

        if (process.env.HAPPYCODEX_DEBUG_CODEX_EVENTS === '1') {
          emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'raw_sdk_event',
              agentScope: 'main',
              displayLevel: 'debug',
              rawType: codexEventType(event),
              summary: summarizeCodexEvent(event),
              rawEvent: event,
            },
          });
        }
      },
    });

    newSessionId = result.threadId ?? newSessionId;
    if (result.exitCode !== 0) {
      const detail =
        result.stderr.trim() || `Codex exec failed (${result.exitCode})`;
      if (sessionId && isCodexResumeSessionMissingError(detail)) {
        throw new Error(`codex_resume_missing_session: ${detail}`);
      }
      if (isCodexContextOverflowError(detail)) {
        const prefix = sessionId
          ? 'codex_resume_context_overflow'
          : 'context_overflow';
        throw new Error(`${prefix}: ${detail}`);
      }
      throw new Error(detail);
    }

    emit({
      status: 'success',
      result: result.finalAnswer,
      newSessionId,
      sourceKind: sourceKindOverride ?? 'sdk_final',
      finalizationReason: 'completed',
    });

    return {
      newSessionId,
      closedDuringQuery: false,
      interruptedDuringQuery: false,
    };
  } finally {
    imageFiles.cleanup();
  }
}

/**
 * Run a single Codex query and stream results via writeOutput.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  memoryRecall: string,
  emitOutput = true,
  images?: Array<{ data: string; mimeType?: string }>,
  sourceKindOverride?: ContainerOutput['sourceKind'],
): Promise<QueryResultState> {
  return runCodexQuery(
    prompt,
    sessionId,
    containerInput,
    memoryRecall,
    emitOutput,
    images,
    sourceKindOverride,
  );
}

/**
 * process.exit() with SIGKILL safety net.
 * When the runner has pending async resources, process.exit() may hang
 * indefinitely. Force SIGKILL after 5 seconds.
 *
 * The timer must NOT use .unref() — if process.exit() silently fails to
 * terminate, an unref'd timer won't keep the loop alive and the SIGKILL never fires.
 * Using a ref'd timer guarantees the safety net triggers.
 */
function forceExitWithSafetyNet(code: number): never {
  log(`Exiting with code ${code}, SIGKILL safety net in 5s`);
  setTimeout(() => {
    console.error(
      '[agent-runner] process.exit() did not terminate, forcing SIGKILL',
    );
    process.kill(process.pid, 'SIGKILL');
  }, 5000);
  process.exit(code);
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  latestSessionId = sessionId;
  const { isHome } = normalizeHomeFlags(containerInput);

  const memoryRecallPrompt = buildMemoryRecallPrompt(isHome);
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale sentinels from previous container runs.
  // Note: _drain is NOT cleaned here — the host's cleanupIpcSentinels() in
  // runForGroup's finally block already removes stale sentinels between runs.
  // A _drain present at startup was written by registerProcess() for the
  // CURRENT run (indicating pending messages arrived during container boot).
  // Deleting it here causes those messages to be silently lost (#xxx).
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  cleanupStartupInterruptSentinel();

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  if (containerInput.isScheduledTask) {
    const scheduledTaskPrefixLines = [
      '[定时任务 - 以下内容由系统自动发送，并非来自用户或群组的直接消息。]',
      '',
      '重要：你正在定时任务模式下运行。请直接给出可发送给用户的最终结果。',
      '',
      '注意：不要输出中间状态或重复消息。',
    ];
    const scheduledTaskPrefix = scheduledTaskPrefixLines.join('\n');
    prompt = scheduledTaskPrefix + '\n\n' + prompt;
  }
  const pendingDrain = drainIpcInput();
  if (pendingDrain.messages.length > 0) {
    log(
      `Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`,
    );
    prompt += '\n' + pendingDrain.messages.map((m) => m.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  try {
    while (true) {
      // 清理残留的 _interrupt sentinel（空闲期间写入的中断信号不应影响下一次 query）。
      // 注意：_drain 不在此处清理 — 如果 _drain 存在，说明有待处理的消息，
      // pollIpcDuringQuery 会在查询结果后检测到并正确退出容器。
      try {
        fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
      } catch {
        /* ignore */
      }
      clearInterruptRequested();

      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        containerInput,
        memoryRecallPrompt,
        true,
        promptImages,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
        latestSessionId = sessionId;
      }
      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        // Notify host that this exit was due to _close, not a normal completion.
        // Without this marker the host treats the exit as silent success and
        // commits the message cursor, causing the in-flight IM message to be
        // consumed without a reply (the "swallowed message" bug).
        writeOutput({ status: 'closed', result: null });
        break;
      }

      // 中断后：跳过 session update
      if (queryResult.interruptedDuringQuery) {
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'status', statusText: 'interrupted' },
          newSessionId: sessionId, // 确保主进程持久化 session ID
        });
        // 清理可能残留的 _interrupt / _drain 文件
        try {
          fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(IPC_INPUT_DRAIN_SENTINEL);
        } catch {
          /* ignore */
        }
        clearInterruptRequested();

        // 等待下一条消息。
        log('Query interrupted by user, waiting for next message');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received after interrupt, exiting');
          // 退出前发送 session 更新，确保主进程持久化最新 session ID
          writeOutput({
            status: 'success',
            result: null,
            newSessionId: sessionId,
          });
          break;
        }
        prompt = nextMessage.text;
        promptImages = nextMessage.images;
        containerInput.turnId = generateTurnId();
        continue;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(
        `Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new query`,
      );
      prompt = nextMessage.text;
      promptImages = nextMessage.images;
      containerInput.turnId = generateTurnId();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`Agent error stack:\n${err.stack}`);
    }
    // Log cause chain for wrapped runtime errors.
    const cause =
      err instanceof Error
        ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause
        : undefined;
    if (cause) {
      const causeMsg =
        cause instanceof Error ? cause.stack || cause.message : String(cause);
      log(`Agent error cause:\n${causeMsg}`);
    }
    log(
      `Agent error errno: ${(err as NodeJS.ErrnoException).code ?? 'none'} exitCode: ${process.exitCode ?? 'none'}`,
    );
    // 不在 error output 中携带 sessionId：
    // 流式输出已通过 onOutput 回调传递了有效的 session 更新。
    // 如果这里携带的是 throw 前的旧 sessionId，会覆盖中间成功产生的新 session。
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    forceExitWithSafetyNet(1);
  }

  // main() 正常结束后必须显式退出。
  // 运行器内部可能留有未关闭的异步资源。如果不调用 process.exit()，
  // Node.js 事件循环不会自动退出，导致 agent-runner 进程挂起并阻塞队列。
  // Safety net 会在 5 秒后强制 SIGKILL。
  forceExitWithSafetyNet(0);
}

// 处理管道断开（EPIPE）：父进程关闭管道后仍有写入时，静默退出避免 code 1 错误输出
(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on(
  'error',
  (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  },
);
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on(
  'error',
  (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  },
);

/**
 * 某些底层 socket 会在管道断开后触发未捕获 EPIPE。
 * 这类错误通常发生在结果已输出之后，属于"收尾写入失败"，
 * 不应把整个 host query 标记为启动失败（code 1）。
 */
process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting gracefully');
  // Emit latest session ID so the host can persist it before we exit.
  // Without this, the host starts a fresh session on restart, losing context.
  if (latestSessionId) {
    try {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: latestSessionId,
      });
    } catch {
      /* stdout may be closed */
    }
  }
  forceExitWithSafetyNet(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting gracefully');
  forceExitWithSafetyNet(0);
});

process.on('uncaughtException', (err: unknown) => {
  const errno = err as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (isWithinInterruptGraceWindow() && isInterruptRelatedError(err)) {
    console.error('Suppressing interrupt-related uncaught exception:', err);
    process.exit(0);
  }
  console.error('Uncaught exception:', err);
  // 尝试输出结构化错误，让主进程能收到错误信息而非仅看到 exit code 1
  try {
    writeOutput({ status: 'error', result: null, error: String(err) });
  } catch {
    /* ignore */
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const errno = reason as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (isWithinInterruptGraceWindow()) {
    console.error('Unhandled rejection during interrupt (non-fatal):', reason);
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
main().catch((err) => {
  console.error('Fatal error in main():', err);
  process.exit(1);
});
