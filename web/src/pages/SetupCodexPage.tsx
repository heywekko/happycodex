import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, ShieldCheck, Terminal } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CodexRuntimeSection } from '../components/settings/CodexRuntimeSection';
import { useAuthStore } from '../stores/auth';

export function SetupCodexPage() {
  const navigate = useNavigate();
  const { user, initialized, checkAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    } else if (user && user.role !== 'admin') {
      navigate('/chat', { replace: true });
    }
  }, [user, initialized, navigate]);

  const handleConfigured = async () => {
    await checkAuth();
    const latestStatus = useAuthStore.getState().setupStatus;
    if (latestStatus?.needsSetup) {
      setError('Codex runtime 已保存，但登录状态验证未通过。请刷新状态后重试。');
      return;
    }
    navigate('/setup/channels', { replace: true });
  };

  const handleFinish = async () => {
    setFinishing(true);
    setError(null);
    try {
      await handleConfigured();
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="h-screen overflow-y-auto bg-background p-4">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-5">
        <div className="text-center">
          <p className="mb-2 text-xs font-semibold tracking-wider text-primary">STEP 2 / 3</p>
          <h1 className="mb-2 text-2xl font-bold text-foreground">Codex Runtime 初始化</h1>
          <p className="text-sm text-muted-foreground">
            配置 HappyCodex 管理的隔离 Codex runtime，完成后再进入消息通道设置。
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-error/30 bg-error-bg px-3 py-2 text-sm text-error">
            {error}
          </div>
        )}

        <Card>
          <CardContent className="space-y-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
                <Terminal className="size-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">隔离运行时登录</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  这里不会读取服务端用户自己的 Codex 配置，也不会把个人 shell 登录态当作产品配置。
                </p>
              </div>
            </div>

            <CodexRuntimeSection
              primaryActionLabel="登录并继续"
              onConfigured={handleConfigured}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              登录成功后点击继续，HappyCodex 会重新验证隔离 runtime 状态。
            </span>
          </div>
          <Button
            onClick={handleFinish}
            disabled={finishing}
            className="min-w-56"
          >
            {finishing && <Loader2 className="size-4 animate-spin" />}
            保存 runtime 并进入消息通道
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
