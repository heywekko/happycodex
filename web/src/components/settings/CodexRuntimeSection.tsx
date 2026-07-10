import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';

import { api } from '../../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  CodexBrowserAuthLogin,
  CodexDeviceAuthLogin,
  CodexRuntimeStatus,
} from './types';
import { getErrorMessage } from './types';

interface CodexRuntimeSectionProps {
  onConfigured?: () => Promise<void> | void;
  primaryActionLabel?: string;
}

export function CodexRuntimeSection({
  onConfigured,
  primaryActionLabel = '保存 Codex API Key',
}: CodexRuntimeSectionProps) {
  const [status, setStatus] = useState<CodexRuntimeStatus | null>(null);
  const [browserLogin, setBrowserLogin] =
    useState<CodexBrowserAuthLogin | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<CodexDeviceAuthLogin | null>(
    null,
  );
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-5.6-sol');
  const [reasoningEffort, setReasoningEffort] = useState('medium');
  const [loading, setLoading] = useState(true);
  const [startingBrowserAuth, setStartingBrowserAuth] = useState(false);
  const [cancellingBrowserAuth, setCancellingBrowserAuth] = useState(false);
  const [startingDeviceAuth, setStartingDeviceAuth] = useState(false);
  const [cancellingDeviceAuth, setCancellingDeviceAuth] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const completedBrowserLogins = useRef(new Set<string>());
  const completedDeviceLogins = useRef(new Set<string>());
  const onConfiguredRef = useRef(onConfigured);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<CodexRuntimeStatus>(
        '/api/config/codex/status',
      );
      setStatus(data);
    } catch (err) {
      setError(getErrorMessage(err, '读取 Codex runtime 状态失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    onConfiguredRef.current = onConfigured;
  }, [onConfigured]);

  useEffect(() => {
    if (!status) return;
    setModel(status.model || 'gpt-5.6-sol');
    setReasoningEffort(status.reasoningEffort || 'medium');
  }, [status]);

  useEffect(() => {
    const loginId = browserLogin?.id;
    if (!loginId || browserLogin.status !== 'pending') return;

    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.get<CodexBrowserAuthLogin>(
          `/api/config/codex/browser-auth/${loginId}`,
        );
        if (cancelled) return;
        setBrowserLogin(data);

        if (
          data.status === 'complete' &&
          !completedBrowserLogins.current.has(data.id)
        ) {
          completedBrowserLogins.current.add(data.id);
          const runtimeStatus = await api.get<CodexRuntimeStatus>(
            '/api/config/codex/status',
          );
          if (cancelled) return;
          setStatus(runtimeStatus);
          setNotice('Codex runtime 已通过 ChatGPT 账号登录。');
          await onConfiguredRef.current?.();
        }
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err, '读取 Codex 登录状态失败'));
        }
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [browserLogin?.id, browserLogin?.status]);

  useEffect(() => {
    const loginId = deviceLogin?.id;
    if (!loginId || deviceLogin.status !== 'pending') return;

    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.get<CodexDeviceAuthLogin>(
          `/api/config/codex/device-auth/${loginId}`,
        );
        if (cancelled) return;
        setDeviceLogin(data);

        if (
          data.status === 'complete' &&
          !completedDeviceLogins.current.has(data.id)
        ) {
          completedDeviceLogins.current.add(data.id);
          const runtimeStatus = await api.get<CodexRuntimeStatus>(
            '/api/config/codex/status',
          );
          if (cancelled) return;
          setStatus(runtimeStatus);
          setNotice('Codex runtime 已通过 ChatGPT 账号登录。');
          await onConfiguredRef.current?.();
        }
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err, '读取 Codex 登录状态失败'));
        }
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [deviceLogin?.id, deviceLogin?.status]);

  const startBrowserAuth = async () => {
    setStartingBrowserAuth(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.post<CodexBrowserAuthLogin>(
        '/api/config/codex/browser-auth/start',
        undefined,
        20_000,
      );
      setBrowserLogin(data);
      setDeviceLogin(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Codex 浏览器登录启动失败'));
    } finally {
      setStartingBrowserAuth(false);
    }
  };

  const cancelBrowserAuth = async () => {
    if (!browserLogin) return;
    setCancellingBrowserAuth(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.post<CodexBrowserAuthLogin>(
        `/api/config/codex/browser-auth/${browserLogin.id}/cancel`,
      );
      setBrowserLogin(data);
    } catch (err) {
      setError(getErrorMessage(err, '取消 Codex 浏览器登录失败'));
    } finally {
      setCancellingBrowserAuth(false);
    }
  };

  const startDeviceAuth = async () => {
    setStartingDeviceAuth(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.post<CodexDeviceAuthLogin>(
        '/api/config/codex/device-auth/start',
        undefined,
        20_000,
      );
      setDeviceLogin(data);
      setBrowserLogin(null);
      window.open(data.verificationUri, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err, 'Codex 账号登录启动失败'));
    } finally {
      setStartingDeviceAuth(false);
    }
  };

  const cancelDeviceAuth = async () => {
    if (!deviceLogin) return;
    setCancellingDeviceAuth(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.post<CodexDeviceAuthLogin>(
        `/api/config/codex/device-auth/${deviceLogin.id}/cancel`,
      );
      setDeviceLogin(data);
    } catch (err) {
      setError(getErrorMessage(err, '取消 Codex 账号登录失败'));
    } finally {
      setCancellingDeviceAuth(false);
    }
  };

  const saveApiKey = async () => {
    if (!apiKey.trim()) {
      setError('请填写 OpenAI API Key');
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<CodexRuntimeStatus>(
        '/api/config/codex/api-key',
        {
          apiKey: apiKey.trim(),
        },
      );
      setStatus(data);
      setApiKey('');
      setNotice('Codex runtime 已登录。');
      await onConfigured?.();
    } catch (err) {
      setError(getErrorMessage(err, 'Codex runtime 登录失败'));
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async () => {
    if (!model.trim()) {
      setError('请填写 Codex 模型');
      return;
    }

    setSavingSettings(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<CodexRuntimeStatus>(
        '/api/config/codex/settings',
        {
          model: model.trim(),
          reasoningEffort,
        },
      );
      setStatus(data);
      setNotice('Codex 模型配置已保存。');
    } catch (err) {
      setError(getErrorMessage(err, '保存 Codex 模型配置失败'));
    } finally {
      setSavingSettings(false);
    }
  };

  const continueConfigured = async () => {
    if (!onConfigured) return;
    setContinuing(true);
    setError(null);
    setNotice(null);
    try {
      await onConfigured();
    } finally {
      setContinuing(false);
    }
  };

  const logout = async () => {
    setLoggingOut(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.post<CodexRuntimeStatus>(
        '/api/config/codex/logout',
      );
      setStatus(data);
      setNotice('Codex runtime 已退出登录。');
    } catch (err) {
      setError(getErrorMessage(err, 'Codex runtime 退出登录失败'));
    } finally {
      setLoggingOut(false);
    }
  };

  const modelOptions = Array.from(
    new Set(
      [
        ...(status?.modelPresets ?? [
          'gpt-5.6-sol',
          'gpt-5.5',
          'gpt-5.4',
          'gpt-5.4-mini',
          'gpt-5.3-codex-spark',
        ]),
        model,
      ].filter((value) => value.trim()),
    ),
  );
  const statusUnavailable = !loading && !status && Boolean(error);
  const statusLabel = loading
    ? '正在读取状态'
    : statusUnavailable
      ? 'Codex runtime 状态未知'
      : status?.configured
        ? 'Codex runtime 已登录'
        : 'Codex runtime 未登录';
  const statusIconClass = status?.configured
    ? 'text-success'
    : statusUnavailable
      ? 'text-warning'
      : 'text-muted-foreground';

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-success/30 bg-success-bg px-3 py-2 text-sm text-success">
          {notice}
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CheckCircle2
                className={`size-4 ${statusIconClass}`}
              />
              {statusLabel}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              隔离目录：
              {status?.runtimeHomeRelative ?? 'data/sessions/main/.codex'}
            </div>
            {status?.statusText && (
              <div className="mt-1 text-xs text-muted-foreground">
                CLI 状态：{status.statusText}
              </div>
            )}
            <div className="mt-1 text-xs text-muted-foreground">
              模型：{status?.model ?? 'gpt-5.6-sol'} · 推理强度：
              {status?.reasoningEffort ?? 'medium'}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            刷新
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Brain className="size-4 text-muted-foreground" />
            Codex 模型
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                模型
              </span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground"
              >
                {modelOptions.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                推理强度
              </span>
              <select
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                {(
                  status?.reasoningEfforts ?? ['low', 'medium', 'high', 'xhigh']
                ).map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
            <Button
              onClick={saveSettings}
              disabled={savingSettings || !model.trim()}
              className="sm:min-w-28"
            >
              {savingSettings ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              保存
            </Button>
          </div>
        </div>
      </div>

      {status?.configured ? (
        <div className="rounded-lg border border-success/30 bg-success-bg p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-success">
                Codex runtime 已经完成登录
              </div>
              <p className="mt-1 text-xs text-success/80">
                不需要再次登录。继续后 HappyCodex 会重新验证隔离 runtime 状态。
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {onConfigured && (
                <Button
                  onClick={continueConfigured}
                  disabled={continuing}
                  className="sm:min-w-32"
                >
                  {continuing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  继续下一步
                </Button>
              )}
              <Button variant="outline" onClick={logout} disabled={loggingOut}>
                {loggingOut ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <LogOut className="size-4" />
                )}
                退出 Codex runtime
              </Button>
            </div>
          </div>
        </div>
      ) : statusUnavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning-bg p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <div className="text-sm font-medium text-warning">
                  Codex runtime 状态读取失败
                </div>
                <p className="mt-1 text-xs text-warning/80">
                  这通常是管理后台登录态失效或接口暂不可用，不代表 Codex
                  账号已经退出。
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={refresh}
              disabled={loading}
              className="sm:min-w-24"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              刷新
            </Button>
          </div>
        </div>
      ) : (
        <Tabs defaultValue="browser-auth" className="space-y-3">
          <TabsList>
            <TabsTrigger value="browser-auth">
              <ExternalLink className="size-4" />
              ChatGPT 登录
            </TabsTrigger>
            <TabsTrigger value="device-auth">
              <ShieldCheck className="size-4" />
              设备码
            </TabsTrigger>
            <TabsTrigger value="api-key">
              <KeyRound className="size-4" />
              API Key
            </TabsTrigger>
          </TabsList>

          <TabsContent value="browser-auth" className="space-y-3">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    使用 Codex CLI 官方浏览器登录
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    点击后 HappyCodex 会在服务端运行 codex login，由官方 CLI
                    打开 ChatGPT OAuth 页面并保存隔离 runtime 凭据。
                  </p>
                </div>

                {!browserLogin ||
                ['failed', 'expired', 'cancelled'].includes(
                  browserLogin.status,
                ) ? (
                  <Button
                    onClick={startBrowserAuth}
                    disabled={startingBrowserAuth}
                    className="w-fit"
                  >
                    {startingBrowserAuth ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ExternalLink className="size-4" />
                    )}
                    使用 ChatGPT 账号登录
                  </Button>
                ) : browserLogin.status === 'pending' ? (
                  <div className="space-y-3">
                    <div className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="size-4 animate-spin text-primary" />
                        正在等待官方 Codex CLI 浏览器登录完成。
                      </span>
                    </div>
                    <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                      <span>
                        如果没有看到浏览器窗口，请确认 HappyCodex
                        运行机器可以打开浏览器，或切换到设备码登录。
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={cancelBrowserAuth}
                        disabled={cancellingBrowserAuth}
                      >
                        {cancellingBrowserAuth ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <X className="size-4" />
                        )}
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-success/30 bg-success-bg px-3 py-2 text-sm text-success">
                    Codex runtime 已通过 ChatGPT 账号登录。
                  </div>
                )}

                {browserLogin &&
                  ['failed', 'expired', 'cancelled'].includes(
                    browserLogin.status,
                  ) && (
                    <div className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
                      {browserLogin.message ||
                        '本次浏览器登录未完成，请重新开始。'}
                    </div>
                  )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="device-auth" className="space-y-3">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="text-sm font-medium text-foreground">
                    使用 Codex CLI 官方设备码登录
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    适合远程服务器或无浏览器环境；打开 OpenAI
                    登录页面，输入一次性 code 后 HappyCodex 会自动检测隔离
                    runtime 的登录状态。
                  </p>
                </div>

                {!deviceLogin ||
                ['failed', 'expired', 'cancelled'].includes(
                  deviceLogin.status,
                ) ? (
                  <Button
                    onClick={startDeviceAuth}
                    disabled={startingDeviceAuth}
                    className="w-fit"
                  >
                    {startingDeviceAuth ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ExternalLink className="size-4" />
                    )}
                    使用设备码登录
                  </Button>
                ) : deviceLogin.status === 'pending' ? (
                  <div className="space-y-3">
                    <div className="grid gap-2 rounded-md border border-border bg-background p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                      <div>
                        <div className="text-xs text-muted-foreground">
                          一次性 code
                        </div>
                        <div className="mt-1 font-mono text-lg font-semibold tracking-wide text-foreground">
                          {deviceLogin.userCode}
                        </div>
                      </div>
                      <Button variant="outline" asChild>
                        <a
                          href={deviceLogin.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink className="size-4" />
                          打开登录页面
                        </a>
                      </Button>
                    </div>
                    <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="size-3 animate-spin" />
                        正在等待 OpenAI 登录完成，code 将在{' '}
                        {new Date(deviceLogin.expiresAt).toLocaleTimeString(
                          'zh-CN',
                        )}{' '}
                        过期。
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={cancelDeviceAuth}
                        disabled={cancellingDeviceAuth}
                      >
                        {cancellingDeviceAuth ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <X className="size-4" />
                        )}
                        取消
                      </Button>
                    </div>
                    <div className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
                      设备码是敏感凭据，请只在 OpenAI
                      官方页面使用，不要转发给任何人。
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-success/30 bg-success-bg px-3 py-2 text-sm text-success">
                    Codex runtime 已通过 ChatGPT 账号登录。
                  </div>
                )}

                {deviceLogin &&
                  ['failed', 'expired', 'cancelled'].includes(
                    deviceLogin.status,
                  ) && (
                    <div className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
                      {deviceLogin.message ||
                        '本次账号登录未完成，请重新开始。'}
                    </div>
                  )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="api-key" className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              OpenAI API Key
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                className="font-mono"
                autoComplete="off"
              />
              <Button
                onClick={saveApiKey}
                disabled={saving || !apiKey.trim()}
                className="sm:min-w-44"
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                {primaryActionLabel}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              API Key 会写入 HappyCodex 管理的 Codex
              runtime，不复用服务端用户的个人 Codex 登录态。
            </p>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
