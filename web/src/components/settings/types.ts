export interface CodexRuntimeStatus {
  configured: boolean;
  statusText: string;
  authFileExists: boolean;
  runtimeHomeRelative: string;
  updatedAt: string | null;
  model: string;
  reasoningEffort: string;
  modelPresets: string[];
  reasoningEfforts: string[];
  error?: string;
}

export interface CodexDeviceAuthLogin {
  id: string;
  status: 'pending' | 'complete' | 'failed' | 'expired' | 'cancelled';
  verificationUri: string;
  userCode: string;
  expiresAt: string;
  runtimeHomeRelative: string;
  message?: string;
}

export interface CodexBrowserAuthLogin {
  id: string;
  status: 'pending' | 'complete' | 'failed' | 'expired' | 'cancelled';
  runtimeHomeRelative: string;
  message?: string;
}

// ─── 通用类型 ────────────────────────────────────────────────

export interface EnvRow {
  key: string;
  value: string;
}

export interface SessionInfo {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  is_current: boolean;
}

export interface SystemSettings {
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxConcurrentHostProcesses: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
  billingEnabled: boolean;
  billingMode: 'wallet_first';
  billingMinStartBalanceUsd: number;
  billingCurrency: string;
  billingCurrencyRate: number;
  externalClaudeDir: string;
  pluginAutoScan: boolean;
  taskBackfillGraceMs: number;
}

export type SettingsTab =
  | 'codex'
  | 'registration'
  | 'appearance'
  | 'system'
  | 'profile'
  | 'my-channels'
  | 'security'
  | 'groups'
  | 'memory'
  | 'skills'
  | 'mcp-servers'
  | 'plugins'
  | 'users'
  | 'about'
  | 'bindings'
  | 'usage'
  | 'monitor';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
