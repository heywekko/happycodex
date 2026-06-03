/**
 * Shared types for HappyCodex Agent Runner.
 *
 * These types are used by the Codex agent runner.
 */

// Streaming event types (canonical source: shared/stream-event.ts)
export type { StreamEventType, StreamEvent } from './stream-event.types.js';
import type { RuntimeContextAudit, StreamEvent } from './stream-event.types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  turnId?: string;
  groupFolder: string;
  chatJid: string;
  /** Source JID of the latest message that triggered this run (e.g. `discord:123…`).
   * Used by per-channel MCP tools (discord_*, etc.) to identify the current
   * incoming chat. Undefined when chatJid already encodes the IM source. */
  currentSourceJid?: string;
  /** @deprecated Use isHome + isAdminHome instead. Kept for backward compatibility with older host processes. */
  isMain?: boolean;
  /** Whether this is the user's home container (admin or member). */
  isHome?: boolean;
  /** Whether this is the admin's home container (full privileges). */
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Task ID associated with the latest unprocessed message, when applicable. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  /**
   * Runtime plugin/resource roots available to this session. Each `path` must
   * be an absolute path already translated by container-runner: container-
   * internal for Docker, host absolute path for host mode.
   */
  plugins?: Array<{ type: 'local'; path: string }>;
  /** Runtime context audit bootstrap from the host/container launcher. */
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
  sourceKind?: 'sdk_final' | 'sdk_send_message' | 'interrupt_partial' | 'overflow_partial' | 'compact_partial' | 'legacy' | 'auto_continue';
  finalizationReason?: 'completed' | 'interrupted' | 'error';
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
