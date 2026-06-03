import { useState } from 'react';
import { Github, ExternalLink, Heart, Code2, Lightbulb, Bug } from 'lucide-react';
import { BugReportDialog } from '@/components/common/BugReportDialog';
import { Button } from '@/components/ui/button';

export function AboutSection() {
  const [showBugReport, setShowBugReport] = useState(false);

  return (
    <div className="space-y-6">
      {/* 项目信息 */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">HappyCodex</h2>
        <p className="text-sm text-muted-foreground">HappyClaw-derived self-hosted Agent product for Codex</p>
      </div>

      {/* 开源地址 & 作者 & 报告问题 */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Github className="w-4 h-4 text-muted-foreground shrink-0" />
          <a
            href="https://github.com/wekko/happycodex"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:text-primary/80 inline-flex items-center gap-1"
          >
            wekko/happycodex
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div className="flex items-center gap-3">
          <Code2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-foreground">维护者：HappyCodex contributors</span>
        </div>
        <div className="flex items-center gap-3">
          <Bug className="w-4 h-4 text-muted-foreground shrink-0" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowBugReport(true)}
          >
            <Bug className="w-3.5 h-3.5" />
            报告问题
          </Button>
        </div>
      </div>

      <BugReportDialog
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
      />

      <hr className="border-border" />

      {/* 灵感来源 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-medium text-foreground">灵感来源</h3>
        </div>
        <div className="space-y-4 text-sm text-muted-foreground">
          <div>
            <a
              href="https://github.com/slopus/happy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium inline-flex items-center gap-1"
            >
              Happy
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              早期让我看到“把命令行 Agent 产品化”价值的项目。它证明了浏览器和消息渠道可以成为 Agent 的入口，而不必把使用场景限制在本地终端。
            </p>
          </div>
          <div>
            <a
              href="https://github.com/openclaw/openclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium inline-flex items-center gap-1"
            >
              OpenClaw
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              一个重要的自托管 Agent 参考项目。HappyCodex 选择继承成熟产品壳，把精力集中在 Codex runtime 集成，而不是重新发明多用户、会话、文件和渠道系统。
            </p>
          </div>
        </div>
      </div>

      <hr className="border-border" />

      {/* 设计哲学 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Heart className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-medium text-foreground">设计哲学</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          严格继承 HappyClaw 的产品形态，在 runner/runtime 边界把底层 Agent 替换为 Codex。
        </p>
      </div>

    </div>
  );
}
