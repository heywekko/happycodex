# HappyCodex — AI 协作者指南

本文档帮助 AI 和工程协作者快速理解 HappyCodex 的项目定位、修改边界与常用验证方式。

## 项目定位

HappyCodex 是一个面向 Codex 的自托管多用户 Agent 产品。

它参考并继承 HappyClaw 的产品形态和工程能力：多用户、工作区、Web 聊天、IM 绑定、任务、文件、Skills、Plugins、MCP、监控、host/container 运行模式等产品壳层能力，都以 HappyClaw 为基线。

HappyCodex 的核心差异是：把底层 Agent Runtime 从 Claude Code 换成 Codex CLI。

## 修改原则

- 简洁优先：每次变更尽量小，避免顺手重构。
- 根因导向：修问题先找清楚原因，不做临时绕过。
- 产品壳层优先对齐 HappyClaw：HappyClaw 已经实现的产品能力，不在 HappyCodex 中重新设计。
- Codex 差异只放在 Runtime 边界：认证、`CODEX_HOME`、Codex CLI 调用、JSONL 事件解析、final answer、session/thread 恢复。
- 不保留错误的 Claude 表面：如果某个 Claude 专属能力无法自然映射到 Codex，应删除或弱化，而不是伪装成可用。

## 架构速览

| 区域 | 说明 |
|------|------|
| `src/` | Hono/SQLite 后端、IM 接入、工作区、任务、文件、插件、MCP、runner 调度 |
| `web/` | React/Vite 前端，包含聊天、设置、监控、任务、文件、插件等页面 |
| `container/agent-runner/` | Agent Runner，负责把 HappyCodex 的请求转换为 Codex CLI 执行 |
| `container/` | 容器镜像和入口脚本 |
| `shared/` | 前后端/runner 共享类型 |
| `tests/` | Vitest 测试 |
| `config/` | 默认配置、HappyClaw 差异预算、挂载白名单 |
| `scripts/` | 检查脚本、类型同步、公开仓库卫生检查 |

## Codex Runtime 边界

HappyCodex 使用服务托管的 Codex 运行态，而不是直接把操作者个人的 `~/.codex` 当作产品运行态。

默认工作区运行目录：

```text
data/sessions/{folder}/.codex
```

容器内挂载路径：

```text
/home/node/.codex
```

Agent Runner 主要通过以下 Codex CLI 形态工作：

```bash
codex exec --json --output-last-message ...
codex exec resume --json --output-last-message ...
```

修改 Codex 相关逻辑时，优先检查：

- `src/codex-runtime.ts`
- `src/codex-mcp-config.ts`
- `src/sdk-query.ts`
- `src/container-runner.ts`
- `container/agent-runner/src/codex-cli.ts`
- `container/agent-runner/src/index.ts`

## 开发边界

### 应该做

- 参考 HappyClaw 已有实现再改 HappyCodex。
- 保持前端、后端、工作区、IM、任务、文件、插件、MCP 等产品壳层行为尽量与 HappyClaw 一致。
- 对 Codex Runtime 差异写小而明确的测试。
- 变更公开文件后运行公开仓库卫生检查。
- 修改产品壳层后运行 HappyClaw 基线检查。

### 不应该做

- 不要在 HappyCodex 中重新实现 HappyClaw 已经完成的产品能力。
- 不要把 Claude provider、Claude OAuth、Claude SDK 事件等 Claude 专属概念硬改成 Codex 名字。
- 不要提交运行数据、日志、数据库、构建产物、依赖目录或登录态。
- 不要把本地私有路径、临时调试说明或个人配置写进公开文档。

## 常用命令

安装依赖：

```bash
npm install
cd web && npm install
cd ../container/agent-runner && npm install
```

开发启动：

```bash
npm run dev:all
```

构建：

```bash
npm run build
npm run build:web
npm --prefix container/agent-runner run build
```

常规验证：

```bash
npm run typecheck
npm test -- --run
npm run check:public-hygiene
```

HappyClaw 基线验证：

```bash
HAPPYCLAW_REF=/path/to/happyclaw npm run check:happyclaw-baseline
```

Codex Runtime 相关测试：

```bash
npm test -- --run tests/codex-cli.test.ts tests/codex-runtime.test.ts tests/sdk-query.test.ts tests/container-runner-plugin-mount.test.ts
```

## 提交要求

- 这是公开项目，提交前必须确认没有敏感数据和本地数据。
- 当前公开历史应保持简洁；如果发布前发现敏感内容进入本地历史，应在公开推送前重写历史移除。
- 公开仓库发布后，不要重写公开历史或 force push，除非用户明确授权。
- 变更说明要写清楚用户可感知影响，避免只写内部实现细节。
