# HappyCodex

HappyCodex 是一个面向 Codex 的自托管多用户 Agent 产品。你可以把它理解为：参考 [HappyClaw](https://github.com/riba2534/happyclaw) 的产品形态和工程能力，把底层 Agent 从 Claude Code 换成 Codex。

HappyClaw 已经实现了完整的多用户、自托管、IM 接入和 Web 管理能力，HappyCodex 不重复造这些轮子。关于完整功能、界面形态和部署思路，可以先看 HappyClaw：

https://github.com/riba2534/happyclaw

## 它能做什么

HappyCodex 继承了 HappyClaw 的核心产品能力：

- 多用户账号、权限和工作区。
- Web 聊天界面和移动端 PWA。
- 飞书、Telegram、QQ、钉钉、微信、Web 等消息入口。
- 文件管理、任务、记忆、Skills、Plugins、MCP。
- host/container 两种 Agent 运行模式。
- 工作区、会话、IM 绑定和队列调度。

区别是：当用户发消息后，实际工作的 Agent Runtime 是 Codex CLI，而不是 Claude Code。

## 和 HappyClaw 有什么不同

### 1. 使用 Codex，而不是 Claude Code

HappyClaw 面向 Claude Code。HappyCodex 面向 Codex。

用户在初始化时配置 Codex 登录态，可以使用 ChatGPT 登录，也可以使用 API Key。配置完成后，多用户共享这套服务端 Codex Runtime。

### 2. 删除或弱化 Claude 专属能力

HappyClaw 里和 Claude 强绑定的能力不会在 HappyCodex 中原样保留，例如：

- Claude provider 配置。
- Claude Code OAuth。
- Claude 用量统计。
- Claude SDK 专属的流式事件细节。

这些能力只有在 Codex 官方能力支持时，才会以 Codex 的方式补回来。

### 3. Codex 回复体验会有差异

HappyClaw 的 Agent 体验来自 Claude Code。HappyCodex 的 Agent 体验来自 Codex CLI。

因此，工作区、任务、文件、IM 绑定等产品功能大体一致，但模型执行过程、事件细节、上下文恢复和最终回答展示，会按 Codex CLI 当前支持的能力来实现。

### 4. 运行态由服务托管

HappyCodex 不直接把操作者个人的 `~/.codex` 当作产品运行态。服务会为工作区维护自己的 Codex 运行目录，例如：

```text
data/sessions/{folder}/.codex
```

这样更适合自托管多用户场景：管理员配置一次 Codex，用户通过 HappyCodex 使用服务端 Agent。

## 快速开始

安装依赖：

```bash
npm install
cd web && npm install
cd ../container/agent-runner && npm install
```

启动前后端：

```bash
npm run dev:all
```

然后打开 Web 页面，按初始化向导创建管理员、登录 Codex、配置需要的消息渠道。

构建生产版本：

```bash
npm run build
npm run build:web
npm --prefix container/agent-runner run build
```

## 给贡献者

HappyCodex 的产品壳层以 HappyClaw 为基线。做产品功能时优先参考 HappyClaw，只有 Codex Runtime 相关部分才应该走 HappyCodex 自己的实现。

常用检查：

```bash
npm run typecheck
npm test -- --run
npm run check:public-hygiene
HAPPYCLAW_REF=/path/to/happyclaw npm run check:happyclaw-baseline
```

## License

MIT
